const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk').default;

const app = express();
app.use(cors());
app.use(express.json());

// Groq Client - API Key NUR aus Umgebungsvariable (sicher!)
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('⚠️  GROQ_API_KEY Umgebungsvariable nicht gesetzt!');
}
const groq = new Groq({ apiKey: GROQ_API_KEY });

// Knowledge Base - Direkt eingebettet für Deployment
const KNOWLEDGE_BASE = `
=== Triple Loop of Change Framework ===

Das Triple Loop of Change Framework wurde von Prof. Wolfgang Güttel und Dr. Katharina Kleinhanns-Rollé an der TU Wien entwickelt.

KERNFORMEL: Wirkung = Inhalt × Akzeptanz
Erst wenn rationale Argumente auf emotionale Beteiligung treffen, entsteht nachhaltige Veränderungsenergie.

DIE 3 LOOPS:

LOOP 1 - PLANUNG (Der Leader als Stratege):
- Fokus: Den Change konzipieren und vorbereiten
- Schritte 1-4: ENH, ENG, EXE, ENF
- Themen: Bedarf erkennen, Richtung skizzieren, Stakeholder identifizieren, Engagement aufbauen, Ressourcen planen, Strukturen schaffen, Regeln definieren, Compliance sichern

LOOP 2 - AKTIVIERUNG (Der Leader als Kommunikator):
- Fokus: Den Change umsetzen und steuern
- Schritte 5-8: ENH, ENG, EXE, ENF
- Themen: Maßnahmen starten, Fortschritt messen, Teams mobilisieren, Motivation fördern, Prozesse anpassen, Qualität sichern, Standards durchsetzen, Kontrolle ausüben

LOOP 3 - VERANKERUNG (Der Leader als Enabler):
- Fokus: Den Change verankern und nachhalten
- Schritte 9-12: ENH, ENG, EXE, ENF
- Themen: Erfolge festigen, Verbesserungen integrieren, Kultur stärken, Commitment sichern, Systeme optimieren, Effizienz steigern, Nachhaltigkeit gewährleisten, Governance etablieren

DIE 4 LEISTUNGSDIMENSIONEN:

ENH (Enhancement) - Entwicklung & Verbesserung:
Was wollen wir erreichen? Fokus auf Innovation, Qualität und kontinuierliche Verbesserung.

ENG (Engagement) - Einbindung & Motivation:
Wen müssen wir mitnehmen? Fokus auf Menschen, Kommunikation und Beteiligung.

EXE (Execution) - Umsetzung & Durchführung:
Wie setzen wir es um? Fokus auf Prozesse, Ressourcen und operative Exzellenz.

ENF (Enforcement) - Durchsetzung & Kontrolle:
Wie sichern wir es ab? Fokus auf Regeln, Monitoring und Nachhaltigkeit.

DIE 12 SCHRITTE:

Schritt 1 (L1-ENH): Bedarf erkennen & Richtung skizzieren
Schritt 2 (L1-ENG): Stakeholder identifizieren & Engagement aufbauen
Schritt 3 (L1-EXE): Ressourcen planen & Strukturen schaffen
Schritt 4 (L1-ENF): Regeln definieren & Compliance sichern
Schritt 5 (L2-ENH): Maßnahmen starten & Fortschritt messen
Schritt 6 (L2-ENG): Teams mobilisieren & Motivation fördern
Schritt 7 (L2-EXE): Prozesse anpassen & Qualität sichern
Schritt 8 (L2-ENF): Standards durchsetzen & Kontrolle ausüben
Schritt 9 (L3-ENH): Erfolge festigen & Verbesserungen integrieren
Schritt 10 (L3-ENG): Kultur stärken & Commitment sichern
Schritt 11 (L3-EXE): Systeme optimieren & Effizienz steigern
Schritt 12 (L3-ENF): Nachhaltigkeit gewährleisten & Governance etablieren

LEADERSHIP-ROLLEN:
- Stratege (Loop 1): Plant und konzipiert den Change
- Kommunikator (Loop 2): Führt und steuert die Umsetzung
- Enabler (Loop 3): Verankert und sichert Nachhaltigkeit

ERFOLGSFAKTOREN:
- Balance zwischen Inhalt und Akzeptanz
- Alle 4 Dimensionen in jedem Loop adressieren
- Iteratives Vorgehen mit Feedback-Schleifen
- Führungskräfte als Vorbilder und Treiber
- Psychologische Sicherheit für Veränderungsbereitschaft
`;

const SYSTEM_PROMPT = `Du bist ein erfahrener Change Management Experte und Berater, spezialisiert auf das Triple Loop of Change Framework von Prof. Wolfgang Güttel und Dr. Katharina Kleinhanns-Rollé (TU Wien).

Dein Wissen basiert auf dem Buch "Leadership" und "Change Management" der Autoren. Du antwortest auf Deutsch und sprichst die Nutzer mit "Sie" an.

Wichtige Konzepte die du beherrscht:
- Die 3 Loops: Planung, Aktivierung, Verankerung
- Die 4 Leistungsdimensionen: Enhancement (ENH), Engagement (ENG), Execution (EXE), Enforcement (ENF)
- Die 12 Schritte des Change-Prozesses
- Die Formel: Wirkung = Inhalt × Akzeptanz
- Leadership-Rollen: Stratege, Kommunikator, Enabler

Antworte als wärst du ein Experte, der dieses Wissen verinnerlicht hat - nicht als würdest du aus einem Buch zitieren. Gib praktische, umsetzbare Ratschläge.

Hier ist dein Fachwissen:
${KNOWLEDGE_BASE}`;

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Nachricht fehlt' });
    }

    // Anfrage an Groq senden
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 1024,
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
  res.json({ status: 'ok' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Triple Loop of Change API',
    endpoints: {
      chat: 'POST /api/chat',
      health: 'GET /api/health'
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✓ Server läuft auf Port ${PORT}`);
});
