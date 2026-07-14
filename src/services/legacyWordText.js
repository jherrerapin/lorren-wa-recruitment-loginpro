const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MAX_EXTRACTED_TEXT_LENGTH = 12000;
const MIN_SEQUENCE_LENGTH = 4;

function normalizeExtractedText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}

function isReadableCodePoint(codePoint) {
  return codePoint === 9
    || codePoint === 10
    || codePoint === 13
    || (codePoint >= 32 && codePoint <= 126)
    || (codePoint >= 160 && codePoint <= 383);
}

function appendDecodedSequence(sequences, buffer, encoding, start, end, minimumByteLength) {
  if (start < 0 || end - start < minimumByteLength) return;
  const sequence = buffer.toString(encoding, start, end);
  if (sequence.trim().length >= MIN_SEQUENCE_LENGTH) sequences.push(sequence);
}

function collectAsciiSequences(buffer) {
  const sequences = [];
  let start = -1;

  for (let offset = 0; offset < buffer.length; offset += 1) {
    if (isReadableCodePoint(buffer[offset])) {
      if (start === -1) start = offset;
      continue;
    }

    appendDecodedSequence(sequences, buffer, 'latin1', start, offset, MIN_SEQUENCE_LENGTH);
    start = -1;
  }

  appendDecodedSequence(sequences, buffer, 'latin1', start, buffer.length, MIN_SEQUENCE_LENGTH);
  return sequences;
}

function collectUtf16LeSequences(buffer) {
  const sequences = [];

  for (const startOffset of [0, 1]) {
    let start = -1;
    for (let offset = startOffset; offset + 1 < buffer.length; offset += 2) {
      const codePoint = buffer.readUInt16LE(offset);
      if (isReadableCodePoint(codePoint)) {
        if (start === -1) start = offset;
        continue;
      }

      appendDecodedSequence(sequences, buffer, 'utf16le', start, offset, MIN_SEQUENCE_LENGTH * 2);
      start = -1;
    }

    const alignedEnd = buffer.length - ((buffer.length - startOffset) % 2);
    appendDecodedSequence(sequences, buffer, 'utf16le', start, alignedEnd, MIN_SEQUENCE_LENGTH * 2);
  }

  return sequences;
}

function isMeaningfulSequence(value = '') {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length < MIN_SEQUENCE_LENGTH) return false;
  const lettersAndNumbers = compact.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/g) || [];
  return lettersAndNumbers.length >= MIN_SEQUENCE_LENGTH;
}

export function isLegacyWordBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= OLE_COMPOUND_FILE_SIGNATURE.length
    && buffer.subarray(0, OLE_COMPOUND_FILE_SIGNATURE.length).equals(OLE_COMPOUND_FILE_SIGNATURE);
}

export function extractLegacyWordText(buffer) {
  if (!isLegacyWordBuffer(buffer)) {
    return { ok: false, text: '', reason: 'invalid_doc_container' };
  }

  const sequences = [
    ...collectAsciiSequences(buffer),
    ...collectUtf16LeSequences(buffer)
  ];
  const uniqueSequences = [...new Set(
    sequences
      .map((sequence) => normalizeExtractedText(sequence))
      .filter(isMeaningfulSequence)
  )];
  const text = normalizeExtractedText(uniqueSequences.join('\n'));

  return {
    ok: Boolean(text),
    text,
    reason: text ? 'doc_text_extracted' : 'empty_doc_text'
  };
}
