// test-saver.js
const fs = require('fs/promises');
// The URL of your locally running Worker (from 'wrangler dev')
const WORKER_URL = 'http://127.0.0.1:8787/'; 
const OUTPUT_FILE = 'coinglass-screenshot.png';

async function saveWorkerScreenshot() {
  console.log(`Fetching screenshot from: ${WORKER_URL}`);

  try {
    const response = await fetch(WORKER_URL);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    // Get the response body as an ArrayBuffer
    const buffer = await response.arrayBuffer();

    // Write the ArrayBuffer (image data) to a local file
    await fs.writeFile(OUTPUT_FILE, Buffer.from(buffer));

    console.log(`✅ Screenshot successfully saved to **${OUTPUT_FILE}**`);

  } catch (error) {
    console.error('❌ Failed to fetch and save screenshot:', error);
  }
}

saveWorkerScreenshot();