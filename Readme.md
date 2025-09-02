GD Team OLLAMA Assistant

Overview

GD Team OLLAMA Assistant is a full-stack web application designed to be an intelligent visual and textual assistant. It leverages the power of local large language models (LLMs) running via the Ollama API to provide a comprehensive suite of features, including:
- Conversational Chat: Engage in a standard chat with the language model.
- CSV Analysis & Generation: Upload a CSV file for analysis or ask the model to generate one from a text prompt.
- PDF Analysis: Upload a PDF to have its contents analyzed and summarized.
- Image Analysis & Generation: Upload an image for description or generate a new image from a text prompt.- Real-time Data: The assistant can answer questions about the current date and time.

The server is built with Node.js and Express, while the frontend is a single, self-contained HTML file.

Prerequisites

Before you can run this application, you need to have the following software installed on your machine:

- Node.js and npm: You can download these from the official Node.js website. This project was developed with Node.js version 18 or higher.
- Ollama: This is the core engine that runs the language models locally. Follow the instructions on the Ollama website to install it for your operating system.

Installing the Models:
After installing Ollama, you must download the specific models used by this application. Open your terminal or command prompt and run the following commands:

ollama pull llama3.2-vision:11b

>> Setup and Installation

Clone the repository:

git clone [https://github.com/bijoy-gd/GD_Team_OLLAMA_Assistant.git](https://github.com/bijoy-gd/GD_Team_OLLAMA_Assistant.git)
cd GD_Team_OLLAMA_Assistant

Install Node.js dependencies:

npm install

>>Running the Application:

Once all prerequisites and dependencies are installed, you can start the server by entering below command in terminal:

node server.js

The server will start on http://localhost:3000 

+ It will also automatically attempt to open this URL in your default web browser.


>>How to Use

The application's interface is divided into a chat history section and a response section.

- Standard Chat: Type a message into the input box and click Chat.
- File Analysis: Click the Attach File button to upload a .csv, .pdf, or image file (.png, .jpg, etc.). Once attached, the relevant analysis buttons will become active.
- Command-based Actions: You can also trigger file generation directly from the chat prompt using a specific syntax:
  - Generate a CSV: Type Generate CSV: [your prompt here]
  - Generate an Image: Type Generate Image: [your prompt here]
  
  
Configuration

The Ollama models used by the server are defined at the top of the server.js file. You can easily change these models to any other compatible model you have installed with Ollama.

Open server.js and modify lines 20 and 21:

// Change these model names to your desired models
const OLLAMA_DEFAULT_MODEL = "llama3.2-vision:11b";
const OLLAMA_MULTIMODAL_MODEL = "llama3.2-vision:11b";

You can find a list of available models on the Ollama website(https://ollama.ai/library). 


For multimodal tasks like image analysis, ensure you choose a model with vision capabilities.

Preview:

<img width="1509" height="830" alt="Screenshot 2025-09-02 at 12 39 46 PM" src="https://github.com/user-attachments/assets/2deb2ad7-fa3d-49cc-97cc-f070df5a5f4e" />




