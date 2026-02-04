const fs = require('fs');
const path = require('path');

// Lade die Knowledge Base
const knowledgeBasePath = path.join(__dirname, 'knowledge_base.txt');
const knowledgeBase = fs.readFileSync(knowledgeBasePath, 'utf-8');

// Teile den Text in Chunks (Absätze)
function createChunks(text, chunkSize = 1500, overlap = 200) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + chunkSize;
    
    // Versuche, am Ende eines Satzes zu enden
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      
      if (breakPoint > start + chunkSize / 2) {
        end = breakPoint + 1;
      }
    }
    
    chunks.push({
      text: text.slice(start, end).trim(),
      start,
      end
    });
    
    start = end - overlap;
  }
  
  return chunks;
}

const chunks = createChunks(knowledgeBase);
console.log(`Knowledge Base geladen: ${chunks.length} Chunks erstellt`);

// Einfache Keyword-basierte Suche (ohne Embeddings für Kostenfreiheit)
function findRelevantChunks(query, topK = 5) {
  const queryWords = query.toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2);
  
  const scored = chunks.map(chunk => {
    const chunkLower = chunk.text.toLowerCase();
    let score = 0;
    
    for (const word of queryWords) {
      // Zähle Vorkommen
      const regex = new RegExp(word, 'gi');
      const matches = chunkLower.match(regex);
      if (matches) {
        score += matches.length;
      }
    }
    
    // Bonus für bestimmte Schlüsselwörter
    const keyTerms = [
      'triple loop', 'change', 'führung', 'leadership', 'veränderung',
      'organisation', 'planung', 'aktivierung', 'verankerung',
      'enhancement', 'engagement', 'execution', 'enforcement',
      'wirkung', 'akzeptanz', 'inhalt', 'transformation'
    ];
    
    for (const term of keyTerms) {
      if (chunkLower.includes(term) && query.toLowerCase().includes(term.split(' ')[0])) {
        score += 5;
      }
    }
    
    return { ...chunk, score };
  });
  
  // Sortiere nach Score und gib die besten zurück
  return scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { findRelevantChunks, chunks };
