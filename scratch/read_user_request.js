const fs = require('fs');

const logPath = 'C:\\Users\\91779\\.gemini\\antigravity-ide\\brain\\30181794-e0b7-4e92-8064-cac680186806\\.system_generated\\logs\\transcript.jsonl';

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
let count = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const data = JSON.parse(line);
    const content = data.content || '';
    if (content.toLowerCase().includes('part d')) {
      console.log(`--- MATCH ${++count} (step_index: ${data.step_index}, source: ${data.source}) ---`);
      console.log(content);
    }
  } catch (e) {
    // Ignore parse errors
  }
}
