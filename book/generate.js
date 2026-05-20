'use strict';

const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');
const QRCode = require('qrcode');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, ImageRun, PageBreak,
  AlignmentType, BorderStyle, ShadingType, WidthType,
  VerticalAlign, TableLayoutType, convertInchesToTwip,
} = require('docx');

// ── Paths ──────────────────────────────────────────────────────────────────
const CONTENT_DIR = path.join(__dirname, 'content');
const OUTPUT_DIR  = path.join(__dirname, 'output');

// ── Helpers ────────────────────────────────────────────────────────────────
function loadYaml(file) {
  return yaml.load(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8'));
}

function loadAllUnits() {
  return fs.readdirSync(CONTENT_DIR)
    .filter(f => /^unit-\d+\.yaml$/.test(f))
    .sort()
    .map(f => loadYaml(f));
}

async function makeQR(url) {
  return QRCode.toBuffer(url, { type: 'png', width: 160, margin: 1 });
}

// ── Section renderers ──────────────────────────────────────────────────────
function sectionHeading(title) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: title })],
    spacing: { before: 240, after: 100 },
  });
}

function renderVocabTable(section) {
  const rows = (section.items || []).map(item => new TableRow({
    children: [
      new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        shading: { fill: 'F5F5F5', type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: item.en || '', bold: true, size: 22 })],
        })],
      }),
      new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: item.translation || '', size: 22 })],
        })],
      }),
    ],
  }));

  return [
    sectionHeading(section.title),
    new Table({
      layout: TableLayoutType.FIXED,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:           { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        bottom:        { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        left:          { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        right:         { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        insideH:       { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
        insideV:       { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      },
      rows,
    }),
  ];
}

function renderExercise(section) {
  const elements = [sectionHeading(section.title)];

  if (section.instruction) {
    elements.push(new Paragraph({
      children: [new TextRun({ text: section.instruction, italics: true, size: 22 })],
      spacing: { before: 60, after: 80 },
    }));
  }

  (section.items || []).forEach(item => {
    elements.push(new Paragraph({
      children: [new TextRun({ text: item, size: 22 })],
      indent: { left: convertInchesToTwip(0.25) },
      spacing: { before: 60, after: 60 },
    }));
  });

  return elements;
}

function renderInfoBox(section) {
  return [
    sectionHeading(section.title),
    new Paragraph({
      shading: { fill: 'FFF8EC', type: ShadingType.CLEAR },
      border: {
        left: { style: BorderStyle.THICK, size: 12, color: 'E8A04C' },
      },
      children: [new TextRun({ text: (section.body || '').trim(), size: 22 })],
      indent: { left: convertInchesToTwip(0.25) },
      spacing: { before: 100, after: 100 },
    }),
  ];
}

function renderSection(section) {
  switch (section.type) {
    case 'vocab_table': return renderVocabTable(section);
    case 'exercise':    return renderExercise(section);
    case 'info_box':    return renderInfoBox(section);
    default:            return renderExercise(section); // fallback
  }
}

// ── Track QR table ─────────────────────────────────────────────────────────
async function buildTrackTable(unit, meta, qrMap) {
  const QR_SIZE = 720000; // ~2 cm in EMU (1 cm = 360000 EMU)

  const rows = [];
  for (let i = 0; i < unit.tracks.length; i += 2) {
    const pair = unit.tracks.slice(i, i + 2);
    const cells = [];

    for (const track of pair) {
      const qrBuf = qrMap[track.id];
      cells.push(new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [
            new ImageRun({
              data: qrBuf,
              transformation: { width: 56, height: 56 },
              type: 'png',
            }),
            new TextRun({ text: `  ${track.id}  ${track.name}`, size: 20 }),
          ],
        })],
      }));
    }

    // pad odd rows
    if (pair.length < 2) {
      cells.push(new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [] })],
      }));
    }

    rows.push(new TableRow({ children: cells }));
  }

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top:     { style: BorderStyle.NONE },
      bottom:  { style: BorderStyle.NONE },
      left:    { style: BorderStyle.NONE },
      right:   { style: BorderStyle.NONE },
      insideH: { style: BorderStyle.SINGLE, size: 2, color: 'EEEEEE' },
      insideV: { style: BorderStyle.NONE },
    },
    rows,
  });
}

// ── Page builders ──────────────────────────────────────────────────────────
function buildCoverPage(meta) {
  return [
    new Paragraph({ children: [], spacing: { before: 2000 } }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.book_title, bold: true, size: 72, color: 'E8A04C' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'Audio Workbook', size: 40, color: '555555' })],
      spacing: { before: 200, after: 200 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `${meta.publisher}  ·  ${meta.year}`, size: 28, color: '888888' })],
    }),
    new Paragraph({
      children: [new PageBreak()],
    }),
  ];
}

function buildTOC(units) {
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: 'Contents' })],
      spacing: { before: 0, after: 200 },
    }),
  ];

  units.forEach(unit => {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `Unit ${unit.unit}  `, bold: true, size: 24 }),
        new TextRun({ text: unit.title, size: 24 }),
      ],
      spacing: { before: 80, after: 80 },
    }));
  });

  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

async function buildUnit(unit, meta, qrMap) {
  const trackTable = await buildTrackTable(unit, meta, qrMap);
  const unitColor  = (unit.color || '#E8A04C').replace('#', '');

  const children = [
    // unit title
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `Unit ${unit.unit} — ${unit.title}` })],
      spacing: { before: 0, after: 160 },
    }),
  ];

  // introduction
  if (unit.introduction) {
    children.push(new Paragraph({
      children: [new TextRun({ text: unit.introduction.trim(), size: 22, color: '444444' })],
      spacing: { before: 80, after: 200 },
    }));
  }

  // audio tracks heading
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: 'Audio Tracks' })],
    spacing: { before: 160, after: 100 },
  }));

  children.push(trackTable);

  // content sections
  for (const section of (unit.sections || [])) {
    for (const el of renderSection(section)) {
      children.push(el);
    }
  }

  // page break after each unit
  children.push(new Paragraph({ children: [new PageBreak()] }));

  return children;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const meta  = loadYaml('meta.yaml');
  const units = loadAllUnits();

  console.log(`Loaded ${units.length} units`);

  // pre-generate all QR codes
  const qrMap = {};
  for (const unit of units) {
    for (const track of (unit.tracks || [])) {
      const url = `${meta.base_url}?book=${meta.level.toLowerCase()}&track=${track.id}`;
      qrMap[track.id] = await makeQR(url);
    }
  }
  console.log(`Generated ${Object.keys(qrMap).length} QR codes`);

  const docChildren = [
    ...buildCoverPage(meta),
    ...buildTOC(units),
  ];

  for (const unit of units) {
    const unitChildren = await buildUnit(unit, meta, qrMap);
    docChildren.push(...unitChildren);
  }

  const doc = new Document({
    creator: meta.publisher,
    title:   meta.book_title,
    description: `${meta.book_title} — Audio Workbook`,
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4 in twips
          margin: {
            top:    convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left:   convertInchesToTwip(1.1),
            right:  convertInchesToTwip(1.1),
          },
        },
      },
      children: docChildren,
    }],
    styles: {
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          run: { size: 36, bold: true, color: '222222' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          run: { size: 26, bold: true, color: 'E8A04C' },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
      ],
    },
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filename = `QuickRebas-${meta.level}-Workbook.docx`;
  const outPath  = path.join(OUTPUT_DIR, filename);
  const buffer   = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);

  console.log(`\nDone! Output: ${outPath}`);
  console.log('Open in Word to add page numbers, adjust layout, and print.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
