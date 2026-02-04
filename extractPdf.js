const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function extractPDF(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  
  let fullText = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }
  
  return fullText;
}

async function main() {
  const basePath = '/Users/elsaedi/Library/CloudStorage/OneDrive-TUWien/Work/TU/L&S/Triple Loop of Change/App Development/triple-loop-app';
  
  const pdfs = [
    'Güttel_Kleinhanns-Rolle _ 2. Leadership.pdf',
    'Güttel_et al._ 3. Change Management.pdf'
  ];

  let allText = '';
  
  for (const pdfFile of pdfs) {
    const pdfPath = path.join(basePath, pdfFile);
    console.log(`Extrahiere: ${pdfFile}...`);
    
    try {
      const text = await extractPDF(pdfPath);
      allText += `\n\n=== ${pdfFile} ===\n\n${text}`;
      console.log(`  ✓ ${text.length} Zeichen extrahiert`);
    } catch (err) {
      console.error(`  ✗ Fehler: ${err.message}`);
    }
  }

  // Speichere den extrahierten Text
  const outputPath = path.join(basePath, 'server', 'knowledge_base.txt');
  fs.writeFileSync(outputPath, allText);
  console.log(`\n✓ Gesamt: ${allText.length} Zeichen in knowledge_base.txt gespeichert`);
}

main();
