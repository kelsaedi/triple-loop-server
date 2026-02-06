const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk').default;

const app = express();
app.use(cors());
app.use(express.json());

// Groq Client - API Key aus Umgebungsvariable
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('⚠️  GROQ_API_KEY Umgebungsvariable nicht gesetzt!');
}
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Knowledge Base laden und in Chunks aufteilen
let knowledgeChunks = [];

function loadKnowledgeBase() {
  try {
    const kbPath = path.join(__dirname, 'knowledge_base.txt');
    const content = fs.readFileSync(kbPath, 'utf-8');

    // In Absätze aufteilen (doppelte Zeilenumbrüche)
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 50);

    // Chunks erstellen (ca. 1500 Zeichen pro Chunk für besseren Kontext)
    knowledgeChunks = [];
    let currentChunk = '';

    for (const para of paragraphs) {
      if (currentChunk.length + para.length > 1500) {
        if (currentChunk.trim()) {
          knowledgeChunks.push(currentChunk.trim());
        }
        currentChunk = para;
      } else {
        currentChunk += '\n\n' + para;
      }
    }
    if (currentChunk.trim()) {
      knowledgeChunks.push(currentChunk.trim());
    }

    console.log(`✓ Knowledge Base geladen: ${knowledgeChunks.length} Chunks`);
  } catch (error) {
    console.error('Fehler beim Laden der Knowledge Base:', error.message);
  }
}

// Relevante Chunks finden (einfaches Keyword-Matching)
function findRelevantChunks(query, maxChunks = 8) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);

  // Wichtige Keywords für das Framework
  const frameworkKeywords = [
    'loop', 'loop 1', 'loop 2', 'loop 3',
    'planung', 'aktivierung', 'verankerung',
    'enhancement', 'engagement', 'execution', 'enforcement',
    'enh', 'eng', 'exe', 'enf',
    'wirkung', 'akzeptanz', 'inhalt',
    'change', 'veränderung', 'führung', 'leadership',
    'stratege', 'kommunikator', 'enabler',
    'schritt', 'dimension', 'phase'
  ];

  // Scores für jeden Chunk berechnen
  const scored = knowledgeChunks.map((chunk, index) => {
    const chunkLower = chunk.toLowerCase();
    let score = 0;

    // Exakte Query-Wörter
    for (const word of queryWords) {
      if (chunkLower.includes(word)) {
        score += 3;
      }
    }

    // Framework-spezifische Keywords
    for (const keyword of frameworkKeywords) {
      if (queryLower.includes(keyword) && chunkLower.includes(keyword)) {
        score += 5;
      }
    }

    // Bonus für Loop-spezifische Fragen
    if (queryLower.includes('loop 1') && chunkLower.includes('loop 1')) score += 10;
    if (queryLower.includes('loop 2') && chunkLower.includes('loop 2')) score += 10;
    if (queryLower.includes('loop 3') && chunkLower.includes('loop 3')) score += 10;
    if (queryLower.includes('planung') && chunkLower.includes('planung')) score += 10;
    if (queryLower.includes('aktivierung') && chunkLower.includes('aktivierung')) score += 10;
    if (queryLower.includes('verankerung') && chunkLower.includes('verankerung')) score += 10;

    return { chunk, score, index };
  });

  // Nach Score sortieren und Top-Chunks nehmen
  const topChunks = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map(s => s.chunk);

  // Falls keine relevanten Chunks gefunden, allgemeine Chunks nehmen
  if (topChunks.length === 0) {
    return knowledgeChunks.slice(0, 5);
  }

  return topChunks;
}

const SYSTEM_PROMPT = `Du bist ein erfahrener Change Management Experte und Berater, spezialisiert auf das Triple Loop of Change Framework von Prof. Wolfgang Güttel und Dr. Katharina Kleinhanns-Rollé (TU Wien).

WICHTIG: Dein Wissen basiert AUSSCHLIESSLICH auf dem Buch "Leadership" und "Change Management" der Autoren. Antworte IMMER basierend auf den bereitgestellten Buchinhalten.

Kernprinzipien:
- Die KERNFORMEL: Wirkung = Inhalt × Akzeptanz
- Die 3 Loops: Planung (Stratege), Aktivierung (Kommunikator), Verankerung (Enabler)
- Die 4 Dimensionen: Enhancement (ENH), Engagement (ENG), Execution (EXE), Enforcement (ENF)
- Die 12 Schritte des Change-Prozesses

Regeln für deine Antworten:
1. Beziehe dich KONKRET auf die Buchinhalte und Konzepte
2. Verwende die FACHBEGRIFFE aus dem Buch (Loops, Dimensionen, Schritte)
3. Gib PRAKTISCHE und SPEZIFISCHE Ratschläge basierend auf dem Framework
4. Erkläre Zusammenhänge zwischen den verschiedenen Elementen
5. Antworte auf Deutsch und sieze die Nutzer

Du erhältst relevante Auszüge aus dem Buch, die du für deine Antwort verwenden sollst.`;

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Nachricht fehlt' });
    }

    // Relevante Knowledge-Chunks finden
    const relevantChunks = findRelevantChunks(message);
    const context = relevantChunks.join('\n\n---\n\n');

    // Anfrage an Groq senden
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `RELEVANTE BUCHAUSZÜGE:\n\n${context}\n\n---\n\nFRAGE DES NUTZERS: ${message}\n\nBitte antworte basierend auf den obigen Buchauszügen und deinem Wissen über das Triple Loop of Change Framework.` }
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    const response = completion.choices[0]?.message?.content || 'Entschuldigung, ich konnte keine Antwort generieren.';

    res.json({ response });

  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten: ' + error.message });
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', chunks: knowledgeChunks.length });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Triple Loop of Change API',
    knowledgeChunks: knowledgeChunks.length,
    endpoints: {
      chat: 'POST /api/chat',
      health: 'GET /api/health'
    }
  });
});

// Knowledge Base beim Start laden
loadKnowledgeBase();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✓ Server läuft auf Port ${PORT}`);
});
