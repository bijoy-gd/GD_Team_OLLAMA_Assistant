const axios = require('axios');

const input = process.argv.slice(2).join(" ") || "Describe this model's capabilities.";

async function chatWithQwen(prompt) {
  try {
    const response = await axios.post('http://localhost:11434/api/generate', {
      model: 'qwen2.5vl:latest',
      prompt: prompt,
      stream: false
    });

    console.log("\n🤖 Qwen2.5VL says:\n");
    console.log(response.data.response);

  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

chatWithQwen(input);
