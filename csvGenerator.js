const axios = require('axios');
const fs = require('fs');
const path = require('path');

const inputPrompt = process.argv.slice(2).join(" ") || "Generate a CSV of 5 fictional employees with name, age, department, and salary.";

async function generateCsv(prompt) {
  try {
    const response = await axios.post('http://localhost:11434/api/generate', {
      model: "qwen2.5vl:latest",
      prompt: prompt,
      stream: false
    });

    const output = response.data.response;

    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    const filePath = path.join(outputDir, 'generated.csv');
    fs.writeFileSync(filePath, output, 'utf8');

    console.log("✅ CSV generated and saved to:", filePath);
    console.log("\n📄 Preview:\n");
    console.log(output);

  } catch (error) {
    console.error("❌ Error generating CSV:", error.message);
  }
}

generateCsv(inputPrompt);
