const axios = require('axios');
const fs = require('fs');
const path = require('path');

const imagePath = process.argv[2];
const userPrompt = process.argv.slice(3).join(" ") || "Describe what you see in this image.";

if (!imagePath || !fs.existsSync(imagePath)) {
  console.error("❌ Please provide a valid image file path.");
  process.exit(1);
}

async function analyzeImage(imagePath, prompt) {
  try {
    const imageData = fs.readFileSync(imagePath);
    const base64Image = `data:image/${path.extname(imagePath).slice(1)};base64,${imageData.toString('base64')}`;

    const response = await axios.post('http://localhost:11434/api/generate', {
      model: 'qwen2.5vl:latest',
      prompt: prompt,
      images: [base64Image],
      stream: false
    });

    console.log("\n🖼️ Qwen2.5VL Review:\n");
    console.log(response.data.response);
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

analyzeImage(imagePath, userPrompt);
