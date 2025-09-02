const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');
const pdf = require('pdf-parse'); 
const { exec } = require('child_process');

const app = express();
const port = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static('UI'));

// --- Centralized Ollama Model Configuration ---
const OLLAMA_DEFAULT_MODEL = "llama3.2-vision:11b";
const OLLAMA_MULTIMODAL_MODEL = "llama3.2-vision:11b";

// In-memory storage for conversation history and *analyzed data* per session.
const conversationHistories = {};

// --- Utility Functions for Real-time Data ---
function getSystemDateTime() {
    const now = new Date();
    const options = {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Kolkata', hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-IN', options);
    return `The current date and time in Adimali, Kerala, India is: ${formatter.format(now)}.`;
}

async function getWeather(location = 'Adimali, Kerala, India') {
    console.log(`[UTILITY] Fetching dummy weather for ${location}`);
    return `The current weather in ${location} is sunny with a temperature of 30°C.`;
}

async function dispatchTool(userQuestion) {
    userQuestion = userQuestion.toLowerCase();
    console.log(`[DISPATCH-TOOL] Checking for tool use for question: "${userQuestion}"`);

    if (userQuestion.includes("today's date") || userQuestion.includes("current date") ||
        userQuestion.includes("what date is it") || userQuestion.includes("current time") ||
        userQuestion.includes("what time is it") || userQuestion.includes("date and time")) {
        console.log("[DISPATCH-TOOL] Date/Time tool detected.");
        return { toolUsed: 'get_date_time', data: getSystemDateTime() };
    }

    if (userQuestion.includes("weather") || userQuestion.includes("temperature")) {
        const locationMatch = userQuestion.match(/weather in (.+)/);
        const location = locationMatch ? locationMatch[1].trim() : 'Adimali, Kerala, India';
        console.log(`[DISPATCH-TOOL] Weather tool detected for location: ${location}.`);
        return { toolUsed: 'get_weather', data: await getWeather(location) };
    }
    console.log("[DISPATCH-TOOL] No tool detected.");
    return { toolUsed: null };
}

// Helper function to call Ollama's generate endpoint for content
async function callOllamaGenerate(model, prompt, images = []) {
    console.log(`[OLLAMA-GENERATE-HELPER] Calling Ollama /api/generate. Model: ${model}, Prompt length: ${prompt.length}, Image count: ${images.length}`);
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: model, prompt: prompt, images: images, stream: false
        });
        console.log(`[OLLAMA-GENERATE-HELPER] Received response from Ollama /api/generate. Response length: ${response.data.response.length}`);
        return response.data.response;
    } catch (error) {
        console.error(`❌ [OLLAMA-GENERATE-HELPER] Error calling Ollama generate API with model ${model}:`, error.message);
        if (error.response) {
            console.error(`Ollama API error status: ${error.response.status}`);
            console.error(`Ollama API error data:`, error.response.data);
        }
        throw new Error("Failed to generate content from Ollama.");
    }
}

// --- CSV <-> JSON Conversion Functions ---
async function csvToJson(csvString) {
    return new Promise((resolve, reject) => {
        parse(csvString, { columns: true, skip_empty_lines: true }, (err, records) => {
            if (err) {
                console.error("❌ [CSV_TO_JSON] Error parsing CSV:", err.message);
                return reject(new Error(`Failed to parse CSV: ${err.message}`));
            }
            console.log(`✅ [CSV_TO_JSON] Converted CSV to JSON. ${records.length} records.`);
            resolve(records);
        });
    });
}

async function jsonToCsv(jsonData) {
    return new Promise((resolve, reject) => {
        if (!Array.isArray(jsonData) || jsonData.length === 0) {
            console.warn("⚠️ [JSON_TO_CSV] No data provided to convert to CSV. Returning empty string.");
            return resolve('');
        }
        stringify(jsonData, { header: true }, (err, csvString) => {
            if (err) {
                console.error("❌ [JSON_TO_CSV] Error stringifying JSON to CSV:", err.message);
                return reject(new Error(`Failed to convert JSON to CSV: ${err.message}`));
            }
            console.log(`✅ [JSON_TO_CSV] Converted JSON to CSV. Length: ${csvString.length}`);
            resolve(csvString);
        });
    });
}

function tryParseJson(str) {
    try {
        const json = JSON.parse(str);
        if (typeof json === 'object' && json !== null) {
            return json;
        }
    } catch (e) {
    }
    return null;
}

// ---
// ## Load index.html
// ---

app.get('/', (req, res) => {
    console.log(`[ROUTE] Serving index.html from UI folder.`);
    res.sendFile(path.join(__dirname, 'UI', 'index.html'));
});

// ---
// ## PDF Analysis Endpoint
// ---
app.post('/analyze-pdf', async (req, res) => {
    console.log(`\n--- Endpoint: /analyze-pdf ---`);
    const base64Pdf = req.body.pdf;
    const prompt = req.body.prompt || "Summarize the content of the PDF.";
    let sessionId = req.body.sessionId;

    console.log(`[ANALYZE-PDF] Request start. Raw Session ID: ${sessionId}. Prompt: "${prompt}"`);
    console.log(`[ANALYZE-PDF] Received PDF data length: ${base64Pdf ? base64Pdf.length : '0'}`);

    // Initialize or get session data, including 'analyzedData'
    if (!sessionId || !conversationHistories[sessionId]) {
        sessionId = uuidv4();
        conversationHistories[sessionId] = { history: [], analyzedData: null, analyzedImage: null };
        console.log(`[ANALYZE-PDF] Initializing/Re-initializing session ID: ${sessionId}`);
    } else {
        // Clear previous analyzed data and image if a new PDF is uploaded
        conversationHistories[sessionId].analyzedData = null;
        conversationHistories[sessionId].analyzedImage = null;
    }

    if (!base64Pdf) {
        console.error("[ANALYZE-PDF] ERROR: No PDF data (base64) provided in request body.");
        return res.status(400).json({ error: "❌ No PDF data (base64) provided." });
    }

    // Convert base64 PDF data to a buffer
    const pdfBuffer = Buffer.from(base64Pdf, 'base64');

    let pdfText;
    try {
        console.log("[ANALYZE-PDF] Attempting to parse PDF text...");
        const data = await pdf(pdfBuffer);
        pdfText = data.text;
        console.log(`✅ [ANALYZE-PDF] PDF parsed. Extracted text length: ${pdfText.length}`);
    } catch (parseError) {
        console.error("❌ [ANALYZE-PDF] Error parsing PDF content:", parseError.message);
        return res.status(400).json({ error: `❌ Failed to parse PDF content: ${parseError.message}` });
    }

    // Store the extracted text as analyzed data in the session
    conversationHistories[sessionId].analyzedData = pdfText;
    console.log(`[ANALYZE-PDF] Extracted PDF text stored in session for analysis.`);
    
    // Add the system prompt for Ollama's response formatting
    conversationHistories[sessionId].history.push({
        role: 'system',
        content: `You are an expert document analyst. The user has provided a document (PDF) and the text content has been extracted for you.
        Your task is to analyze the text and respond to the user's request.

        If the user asks you to extract tabular data into a NEW CSV, you MUST respond with the exact phrase "CSV_REQUEST: [Your detailed prompt for generating the transformed CSV from the document text]"
        The prompt you provide after "CSV_REQUEST:" should be precise.
        For example: "CSV_REQUEST: Extract all tables from the document into a single CSV."

        If the user asks you to generate an image based on the document's content, respond with:
        "IMAGE_REQUEST: [Your detailed prompt for generating the image, e.g., 'A diagram illustrating the main points of the document.']"
        
        Otherwise, provide a concise textual response summarizing your findings or answering the user's question.`
    });

    // Construct the prompt for Ollama, including the current user prompt and the *extracted text*.
    const fullPromptForOllama = `${prompt}\n\nDocument Text:\n\`\`\`\n${pdfText}\n\`\`\`\n`;
    console.log(`[ANALYZE-PDF] Full prompt sent to Ollama (first 500 chars): "${fullPromptForOllama.substring(0, Math.min(fullPromptForOllama.length, 500))}"`);

    conversationHistories[sessionId].history.push({ role: 'user', content: fullPromptForOllama });
    console.log(`[ANALYZE-PDF] User message added to history. Current history length: ${conversationHistories[sessionId].history.length}`);
    
    try {
        console.log(`[ANALYZE-PDF] Calling Ollama /api/chat with model: ${OLLAMA_DEFAULT_MODEL}`);
        const response = await axios.post('http://localhost:11434/api/chat', {
            model: OLLAMA_DEFAULT_MODEL,
            messages: conversationHistories[sessionId].history,
            stream: false
        });

        let ollamaResponse = response.data.message.content;
        console.log(`[ANALYZE-PDF] Received raw response from Ollama. Length: ${ollamaResponse.length}. Content preview: "${ollamaResponse.substring(0, Math.min(ollamaResponse.length, 200))}"`);
        
        let fileTypeToGenerate = null;
        let generationPrompt = null;

        // Now, analyze-pdf is looking for CSV_REQUEST or IMAGE_REQUEST
        if (ollamaResponse.startsWith('CSV_REQUEST:')) {
            console.log("[ANALYZE-PDF] Ollama requested external CSV generation.");
            fileTypeToGenerate = 'csv';
            generationPrompt = ollamaResponse.substring('CSV_REQUEST:'.length).trim();
        } else if (ollamaResponse.startsWith('IMAGE_REQUEST:')) {
            console.log("[ANALYZE-PDF] Ollama requested IMAGE generation.");
            fileTypeToGenerate = 'image';
            generationPrompt = ollamaResponse.substring('IMAGE_REQUEST:'.length).trim();
        } else {
            console.log("[ANALYZE-PDF] Ollama returned a textual response, no file generation requested.");
        }

        conversationHistories[sessionId].history.push({ role: 'assistant', content: ollamaResponse });
        console.log(`[ANALYZE-PDF] Ollama's response added to history. New history length: ${conversationHistories[sessionId].history.length}`);
        
        res.status(200).json({
            message: `✅ PDF analysis complete`,
            response: ollamaResponse,
            action: fileTypeToGenerate ? 'generate_file' : undefined,
            fileType: fileTypeToGenerate,
            generationPrompt: generationPrompt,
            sessionId: sessionId
        });
    } catch (error) {
        console.error("❌ [ANALYZE-PDF] Error during Ollama call:", error.message);
        if (error.response) {
            console.error("❌ [ANALYZE-PDF] Ollama API Response Data:", error.response.data);
            console.error("❌ [ANALYZE-PDF] Ollama API Response Status:", error.response.status);
        }
        if (conversationHistories[sessionId] && conversationHistories[sessionId].history.length > 0 && conversationHistories[sessionId].history[conversationHistories[sessionId].history.length - 1].role === 'user') {
            conversationHistories[sessionId].history.pop();
            console.log(`[ANALYZE-PDF] Removed last user message from history due to error. New history length: ${conversationHistories[sessionId].history.length}`);
        }
        res.status(500).json({
            message: '❌ Failed to analyze PDF',
            error: error.message,
            sessionId: sessionId
        });
    }
});

// ---
// ## CSV Generation Endpoint (Now Data-Aware using DeepSeek)
// ---
app.post('/generate-csv', async (req, res) => {
    console.log(`\n--- Endpoint: /generate-csv ---`);
    const { prompt, sessionId } = req.body;
    console.log(`[GENERATE-CSV] Received request. Prompt: "${prompt}", Session ID: "${sessionId}"`);

    if (!prompt || prompt.trim().length === 0) {
        console.error("[GENERATE-CSV] ERROR: Prompt is empty.");
        return res.status(400).json({ message: '❌ Prompt for CSV generation cannot be empty.' });
    }

    let fullPromptForOllama = prompt;
    let dataForGeneration = null;

    if (sessionId && conversationHistories[sessionId] && conversationHistories[sessionId].analyzedData) {
        dataForGeneration = conversationHistories[sessionId].analyzedData;
        console.log(`[GENERATE-CSV] Found analyzed data in session ${sessionId}.`);
        
        // Append the analyzed data to the prompt for Ollama
        // Now, this data can be either a JSON array (from CSV analysis) or a raw text string (from PDF analysis)
        let dataString = '';
        if (Array.isArray(dataForGeneration)) {
            dataString = JSON.stringify(dataForGeneration, null, 2);
            console.log(`[GENERATE-CSV] Data for generation is a JSON array. Length: ${dataString.length}`);
            fullPromptForOllama = `Based on the following data, please generate a CSV: ${prompt}\n\nData (JSON format):\n\`\`\`json\n${dataString}\n\`\`\`\n`;
        } else if (typeof dataForGeneration === 'string') {
            dataString = dataForGeneration;
            console.log(`[GENERATE-CSV] Data for generation is a text string. Length: ${dataString.length}`);
            fullPromptForOllama = `Based on the following document text, please generate a CSV: ${prompt}\n\nDocument Text:\n\`\`\`\n${dataString}\n\`\`\`\n`;
        }
    } else {
        console.log("[GENERATE-CSV] No specific analyzed data found in session. Generating CSV based on prompt alone.");
    }
    
    try {
        let ollamaPromptForJsonOutput = `${fullPromptForOllama}\n\n**IMPORTANT**: Output the result as a JSON array of objects, enclosed in triple backticks and 'json' tag. For example: \`\`\`json\n[{"Col1": "Val1"}, {"Col2": "Val2"}]\n\`\`\` No other text around the JSON.`;
        const rawContentFromOllama = await callOllamaGenerate(OLLAMA_DEFAULT_MODEL, ollamaPromptForJsonOutput);
        console.log(`[GENERATE-CSV] Ollama responded with raw content. Length: ${rawContentFromOllama.length}. Preview: "${rawContentFromOllama.substring(0, Math.min(rawContentFromOllama.length, 100))}"`);

        let finalCsvContent;
        const jsonBlockMatch = rawContentFromOllama.match(/```json\n([\s\S]*?)\n```/);
        if (jsonBlockMatch && jsonBlockMatch[1]) {
            console.log("[GENERATE-CSV] Detected embedded JSON in Ollama's response. Converting to CSV.");
            const parsedJson = tryParseJson(jsonBlockMatch[1].trim());
            if (parsedJson && Array.isArray(parsedJson)) {
                finalCsvContent = await jsonToCsv(parsedJson);
            } else {
                console.warn("[GENERATE-CSV] Ollama returned a JSON block, but it's not a valid JSON array or parsing failed. Treating as raw CSV.");
                finalCsvContent = rawContentFromOllama;
            }
        } else {
            console.warn("[GENERATE-CSV] Ollama did not return a JSON block. Assuming raw content is already CSV.");
            finalCsvContent = rawContentFromOllama;
        }

        if (!finalCsvContent || finalCsvContent.trim().length === 0) {
            console.warn("[GENERATE-CSV] WARNING: Generated CSV content is empty.");
            return res.status(500).json({ message: '❌ Generated empty CSV. Please refine your prompt or data.', csvContent: '', fileName: 'empty_generated.csv' });
        }
        res.status(200).json({ message: '✅ CSV content generated successfully', csvContent: finalCsvContent, fileName: 'generated_data.csv' });
    } catch (error) {
        console.error("❌ CSV Generation Error:", error.message);
        res.status(500).json({ message: '❌ Failed to generate CSV', error: error.message });
    }
});

// ... (Rest of your endpoints like /generate-image, /analyze-csv, /analyze-image, /chat, and /clear-chat-history)
// ---
// ## Image Analysis/Processing Endpoint (Using LLaVA)
// ---
app.post('/generate-image', async (req, res) => {
    console.log(`\n--- Endpoint: /generate-image ---`);
    const { prompt, sessionId } = req.body;
    console.log(`[GENERATE-IMAGE] Received request. Prompt: "${prompt}", Session ID: "${sessionId}"`);

    if (!prompt || prompt.trim().length === 0) {
        console.error("[GENERATE-IMAGE] ERROR: Prompt is empty.");
        return res.status(400).json({ message: '❌ Prompt for Image analysis/processing cannot be empty.' });
    }

    let imagesForOllama = [];
    let fullPromptForOllama = prompt;

    if (sessionId && conversationHistories[sessionId] && conversationHistories[sessionId].analyzedImage) {
        imagesForOllama = [conversationHistories[sessionId].analyzedImage];
        console.log(`[GENERATE-IMAGE] Found analyzed image in session ${sessionId}. Will pass to multimodal model for processing.`);
        fullPromptForOllama = `Given the attached image, please provide a textual output: ${prompt}`;
    } else {
        console.log("[GENERATE-IMAGE] No specific analyzed image found in session. Multimodal model will process text prompt only.");
    }

    try {
        console.log(`[GENERATE-IMAGE] Calling Ollama /api/generate with multimodal model: ${OLLAMA_MULTIMODAL_MODEL}`);
        const responseContent = await callOllamaGenerate(OLLAMA_MULTIMODAL_MODEL, fullPromptForOllama, imagesForOllama);

        console.log(`[GENERATE-IMAGE] Successfully received textual response from multimodal model. Length: ${responseContent.length}. Preview: "${responseContent.substring(0, 50)}"`);

        res.status(200).json({
            message: '✅ Image analysis/description generated successfully',
            response: responseContent,
            fileName: 'image_analysis.txt'
        });
    } catch (error) {
        console.error("❌ Multimodal Image Processing Error:", error.message);
        if (error.response) {
            console.error(`Ollama API error status: ${error.response.status}`);
            console.error(`Ollama API error data:`, error.response.data);
        }
        res.status(500).json({ message: '❌ Failed to process image with multimodal model', error: error.message });
    }
});

// ---
// ## Analyze CSV Endpoint (Now Orchestrates Generation using DeepSeek)
// ---
app.post('/analyze-csv', async (req, res) => {
    console.log(`\n--- Endpoint: /analyze-csv ---`);
    const csvContent = req.body.csv;
    const prompt = req.body.prompt || "Analyze the following CSV data.";
    let sessionId = req.body.sessionId;

    console.log(`[ANALYZE-CSV] Request start. Raw Session ID: ${sessionId}. Prompt: "${prompt}"`);
    console.log(`[ANALYZE-CSV] Received CSV content length: ${csvContent ? csvContent.length : '0'}`);

    if (!sessionId || !conversationHistories[sessionId]) {
        sessionId = uuidv4();
        conversationHistories[sessionId] = { history: [], analyzedData: null, analyzedImage: null };
        console.log(`[ANALYZE-CSV] Initializing/Re-initializing session ID: ${sessionId}`);
    } else {
        conversationHistories[sessionId].analyzedData = null;
        conversationHistories[sessionId].analyzedImage = null;
    }

    conversationHistories[sessionId].history.push({
        role: 'system',
        content: `You are an expert CSV data analyst and transformer.
        The user has provided a CSV file, which has been converted to JSON for you.
        Your primary task is to analyze this data and respond to the user's request.
        If the user asks you to modify, filter, summarize, or extract specific information into a NEW CSV,
        you MUST respond with the exact phrase "CSV_REQUEST: [Your detailed prompt for generating the transformed CSV from the previously analyzed data]"
        The prompt you provide after "CSV_REQUEST:" should be precise and include all necessary instructions for a separate CSV generation step.
        For example: "CSV_REQUEST: Filter the provided data for users in 'Marketing' department and include only 'Name' and 'Email' columns."
        If you determine a numerical summary is needed, provide that directly as text.
        If the user asks you to create an image based on the data, respond with:
        "IMAGE_REQUEST: [Your detailed prompt for generating the image, e.g., 'A bar chart of sales data from the CSV, based on the provided data.']"
        Otherwise, provide a concise textual response summarizing your findings.`
    });
    console.log(`[ANALYZE-CSV] System prompt for new session set. Length: ${conversationHistories[sessionId].history[0].content.length}`);

    if (!csvContent) {
        console.error("[ANALYZE-CSV] ERROR: No CSV content provided in request body.");
        return res.status(400).json({ error: "❌ No CSV content provided." });
    }

    let parsedCsvData;
    try {
        console.log("[ANALYZE-CSV] Attempting to parse CSV content...");
        parsedCsvData = await csvToJson(csvContent);
        conversationHistories[sessionId].analyzedData = parsedCsvData;
        console.log(`[ANALYZE-CSV] CSV parsed and stored in session. ${parsedCsvData.length} records found.`);
        if (parsedCsvData.length > 0) {
            console.log("[ANALYZE-CSV] Parsed CSV headers:", Object.keys(parsedCsvData[0]).join(', '));
            console.log("[ANALYZE-CSV] First record preview:", JSON.stringify(parsedCsvData[0]).substring(0, 100));
        } else {
            console.warn("[ANALYZE-CSV] WARNING: Parsed CSV data is empty after parsing.");
        }
    } catch (parseError) {
        console.error("❌ [ANALYZE-CSV] Error parsing CSV content:", parseError.message);
        return res.status(400).json({ error: "❌ Failed to parse CSV content. Please ensure it's valid CSV format." });
    }

    let fullPromptForOllama = `${prompt}\n\nCSV Data (JSON format):\n\`\`\`json\n${JSON.stringify(parsedCsvData, null, 2)}\n\`\`\`\n`;
    console.log(`[ANALYZE-CSV] Full prompt sent to Ollama (first 500 chars): "${fullPromptForOllama.substring(0, Math.min(fullPromptForOllama.length, 500))}"`);

    conversationHistories[sessionId].history.push({ role: 'user', content: fullPromptForOllama });
    console.log(`[ANALYZE-CSV] User message added to history. Current history length: ${conversationHistories[sessionId].history.length}`);

    try {
        console.log(`[ANALYZE-CSV] Calling Ollama /api/chat with model: ${OLLAMA_DEFAULT_MODEL}`);
        const response = await axios.post('http://localhost:11434/api/chat', {
            model: OLLAMA_DEFAULT_MODEL,
            messages: conversationHistories[sessionId].history,
            stream: false
        });

        let ollamaResponse = response.data.message.content;
        console.log(`[ANALYZE-CSV] Received raw response from Ollama. Length: ${ollamaResponse.length}. Content preview: "${ollamaResponse.substring(0, Math.min(ollamaResponse.length, 200))}"`);

        let fileTypeToGenerate = null;
        let generationPrompt = null;

        if (ollamaResponse.startsWith('CSV_REQUEST:')) {
            console.log("[ANALYZE-CSV] Ollama requested external CSV generation.");
            fileTypeToGenerate = 'csv';
            generationPrompt = ollamaResponse.substring('CSV_REQUEST:'.length).trim();
        } else if (ollamaResponse.startsWith('IMAGE_REQUEST:')) {
            console.log("[ANALYZE-CSV] Ollama requested IMAGE generation.");
            fileTypeToGenerate = 'image';
            generationPrompt = ollamaResponse.substring('IMAGE_REQUEST:'.length).trim();
        } else {
            console.log("[ANALYZE-CSV] Ollama returned a textual response, no file generation requested.");
        }

        conversationHistories[sessionId].history.push({ role: 'assistant', content: ollamaResponse });
        console.log(`[ANALYZE-CSV] Ollama's response added to history. New history length: ${conversationHistories[sessionId].history.length}`);

        res.status(200).json({
            message: `✅ CSV analysis complete`,
            response: ollamaResponse,
            action: fileTypeToGenerate ? 'generate_file' : undefined,
            fileType: fileTypeToGenerate,
            generationPrompt: generationPrompt,
            sessionId: sessionId
        });
    } catch (error) {
        console.error("❌ [ANALYZE-CSV] Error during Ollama call:", error.message);
        if (error.response) {
            console.error("❌ [ANALYZE-CSV] Ollama API Response Data:", error.response.data);
            console.error("❌ [ANALYZE-CSV] Ollama API Response Status:", error.response.status);
        }
        if (conversationHistories[sessionId] && conversationHistories[sessionId].history.length > 0 && conversationHistories[sessionId].history[conversationHistories[sessionId].history.length - 1].role === 'user') {
            conversationHistories[sessionId].history.pop();
            console.log(`[ANALYZE-CSV] Removed last user message from history due to error. New history length: ${conversationHistories[sessionId].history.length}`);
        }
        res.status(500).json({
            message: '❌ Failed to analyze CSV',
            error: error.message,
            sessionId: sessionId
        });
    }
});

// ---
// ## Analyze Image Endpoint (Now Orchestrates Generation using LLaVA)
// ---
app.post('/analyze-image', async (req, res) => {
    console.log(`\n--- Endpoint: /analyze-image ---`);
    const base64Image = req.body.image;
    const prompt = req.body.prompt || "Describe this image.";
    let sessionId = req.body.sessionId;

    console.log(`[ANALYZE-IMAGE] Request start. Raw Session ID: ${sessionId}. Prompt: "${prompt}"`);
    console.log(`[ANALYZE-IMAGE] Received Image data length: ${base64Image ? base64Image.length : '0'}`);

    if (!sessionId || !conversationHistories[sessionId]) {
        sessionId = uuidv4();
        conversationHistories[sessionId] = { history: [], analyzedData: null, analyzedImage: null };
        console.log(`[ANALYZE-IMAGE] Initializing/Re-initializing session ID: ${sessionId}`);
    } else {
        conversationHistories[sessionId].analyzedImage = null;
        conversationHistories[sessionId].analyzedData = null;
    }

    if (base64Image) {
        conversationHistories[sessionId].analyzedImage = base64Image;
        console.log(`[ANALYZE-IMAGE] Image stored in session ${sessionId}.`);
    }

    conversationHistories[sessionId].history.push({
        role: 'system',
        content: `You are a helpful assistant capable of analyzing images.
        The user has provided an image for analysis.
        Your task is to describe the image or answer questions related to its content.
        If the user asks you to generate a new image (e.g., "draw a dog in this style", "remove background from this image"),
        you MUST respond with the exact phrase "IMAGE_REQUEST: [Your detailed prompt for generating the image, possibly transforming the previously analyzed image]"
        The prompt you provide after "IMAGE_REQUEST:" should be precise and reference the original image context if applicable.
        For example: "IMAGE_REQUEST: A photorealistic image of a dog in the same style as the provided image."
        If the user asks you to extract information into a CSV based on the image, respond with:
        "CSV_REQUEST: [Your detailed prompt for CSV generation based on image analysis, e.g., 'List all objects detected in the image as a CSV.']"
        Otherwise, provide a concise textual response summarizing your findings.`
    });
    console.log(`[ANALYZE-IMAGE] System prompt for new session set. Length: ${conversationHistories[sessionId].history[0].content.length}`);

    if (!base64Image) {
        console.error("[ANALYZE-IMAGE] ERROR: No image data (base64) provided in request body.");
        return res.status(400).json({ error: "❌ No image data (base64) provided." });
    }

    let fullPromptForOllama = prompt;

    conversationHistories[sessionId].history.push({ role: 'user', content: fullPromptForOllama, images: [base64Image] });
    console.log(`[ANALYZE-IMAGE] User message with image added to history. Current history length: ${conversationHistories[sessionId].history.length}`);

    try {
        console.log(`[ANALYZE-IMAGE] Calling Ollama /api/chat with model: ${OLLAMA_MULTIMODAL_MODEL} for analysis.`);
        const response = await axios.post('http://localhost:11434/api/chat', {
            model: OLLAMA_MULTIMODAL_MODEL,
            messages: conversationHistories[sessionId].history,
            stream: false
        });

        let ollamaResponse = response.data.message.content;
        console.log(`[ANALYZE-IMAGE] Received raw response from Ollama. Length: ${ollamaResponse.length}. Content preview: "${ollamaResponse.substring(0, Math.min(ollamaResponse.length, 200))}"`);

        let fileTypeToGenerate = null;
        let generationPrompt = null;
        let transformedCsvOutput = null;

        if (ollamaResponse.startsWith('IMAGE_REQUEST:')) {
            console.log("[ANALYZE-IMAGE] Ollama requested external IMAGE generation.");
            fileTypeToGenerate = 'image';
            generationPrompt = ollamaResponse.substring('IMAGE_REQUEST:'.length).trim();
        } else if (ollamaResponse.startsWith('CSV_REQUEST:')) {
            console.log("[ANALYZE-IMAGE] Ollama requested external CSV generation based on image analysis.");
            fileTypeToGenerate = 'csv';
            generationPrompt = ollamaResponse.substring('CSV_REQUEST:'.length).trim();
            const jsonBlockMatch = ollamaResponse.match(/```json\n([\s\S]*?)\n```/);
            if (jsonBlockMatch && jsonBlockMatch[1]) {
                console.warn("[ANALYZE-IMAGE] WARN: Ollama directly embedded JSON for CSV. This should ideally be handled by generate-csv via request.");
                const parsedJsonFromOllama = tryParseJson(jsonBlockMatch[1].trim());
                if (parsedJsonFromOllama && Array.isArray(parsedJsonFromOllama)) {
                    try {
                        transformedCsvOutput = await jsonToCsv(parsedJsonFromOllama);
                        ollamaResponse = ollamaResponse.replace(jsonBlockMatch[0], '').trim();
                        if (ollamaResponse.length === 0 && transformedCsvOutput.length > 0) {
                            ollamaResponse = "Detected objects/attributes as CSV. Please download.";
                        }
                    } catch (csvConvertError) {
                        console.error("❌ [ANALYZE-IMAGE] Error converting Ollama's JSON to CSV:", csvConvertError.message);
                        ollamaResponse = `Ollama provided JSON, but failed to convert it to CSV: ${csvConvertError.message}\n\nOriginal Ollama response part: ${ollamaResponse}`;
                        fileTypeToGenerate = null;
                    }
                }
            }
        } else {
            console.log("[ANALYZE-IMAGE] Ollama returned a textual response, no file generation requested.");
        }

        conversationHistories[sessionId].history.push({ role: 'assistant', content: ollamaResponse });
        console.log(`[ANALYZE-IMAGE] Ollama's response added to history. New history length: ${conversationHistories[sessionId].history.length}`);

        res.status(200).json({
            message: '✅ Image analysis complete',
            response: ollamaResponse,
            action: fileTypeToGenerate ? 'generate_file' : undefined,
            fileType: fileTypeToGenerate,
            generationPrompt: generationPrompt,
            csvContent: transformedCsvOutput,
            sessionId: sessionId
        });
    } catch (error) {
        console.error("❌ [ANALYZE-IMAGE] Error during Ollama call:", error.message);
        if (error.response) {
            console.error("❌ [ANALYZE-IMAGE] Ollama API Response Data:", error.response.data);
            console.error("❌ [ANALYZE-IMAGE] Ollama API Response Status:", error.response.status);
        }
        if (conversationHistories[sessionId] && conversationHistories[sessionId].history.length > 0 && conversationHistories[sessionId].history[conversationHistories[sessionId].history.length - 1].role === 'user') {
            console.log(`[ANALYZE-IMAGE] Error occurred after adding user message with image. Session history might be inconsistent.`);
        }
        res.status(500).json({
            message: '❌ Failed to analyze image',
            error: error.message,
            sessionId: sessionId
        });
    }
});

// ---
// ## CHAT: Conversational Question Answering Endpoint (Using DeepSeek)
// ---
app.post('/chat', async (req, res) => {
    console.log(`\n--- Endpoint: /chat ---`);
    const userQuestion = req.body.question;
    let sessionId = req.body.sessionId;

    console.log(`[CHAT] Request start. Raw Session ID: ${sessionId}. User Question: "${userQuestion}"`);

    const lowerCaseQuestion = userQuestion.toLowerCase();
    let fileTypeToGenerateDirectly = null;
    let generationPromptDirectly = null;

    if (lowerCaseQuestion.startsWith('generate csv:')) {
        fileTypeToGenerateDirectly = 'csv';
        generationPromptDirectly = userQuestion.substring('generate csv:'.length).trim();
        console.log(`[CHAT] Direct CSV generation command detected. Prompt: "${generationPromptDirectly}"`);
    } else if (lowerCaseQuestion.startsWith('generate image:') || lowerCaseQuestion.startsWith('show me an image of:')) {
        fileTypeToGenerateDirectly = 'image';
        if(lowerCaseQuestion.startsWith('generate image:')) {
            generationPromptDirectly = userQuestion.substring('generate image:'.length).trim();
        } else {
            generationPromptDirectly = userQuestion.substring('show me an image of:'.length).trim();
        }
        console.log(`[CHAT] Direct IMAGE generation command detected. Prompt: "${generationPromptDirectly}"`);
    }

    if (fileTypeToGenerateDirectly) {
        console.log(`[CHAT] Responding with direct generate_file action for frontend.`);
        res.status(200).json({
            message: `✅ Command received to generate ${fileTypeToGenerateDirectly}.`,
            action: 'generate_file',
            fileType: fileTypeToGenerateDirectly,
            generationPrompt: generationPromptDirectly,
            sessionId: sessionId
        });
        return;
    }

    if (!sessionId || !conversationHistories[sessionId]) {
        sessionId = uuidv4();
        conversationHistories[sessionId] = { history: [], analyzedData: null, analyzedImage: null };
        console.log(`[CHAT] New session created: ${sessionId}`);
        let systemContent = `You are a helpful assistant. I have access to real-time information such as the current date, time, and weather. The current date and time in Adimali, Kerala, India is: ${getSystemDateTime()}.`;
        systemContent += `\nIf, based on the conversational context, you determine a CSV should be generated, respond with: "CSV_REQUEST: [Your detailed prompt for CSV generation here]".`;
        systemContent += `\nIf you determine an image should be generated, respond with: "IMAGE_REQUEST: [Your detailed prompt for image generation here]".`;
        systemContent += `\nOtherwise, keep your responses concise and relevant to the conversation.`;
        conversationHistories[sessionId].history.push({ role: 'system', content: systemContent });
        console.log(`[CHAT] System prompt for new session set. Length: ${conversationHistories[sessionId].history[0].content.length}`);
    }

    let toolResult = null;
    const toolCheck = await dispatchTool(userQuestion);

    if (toolCheck.toolUsed) {
        console.log(`⚙️ Tool '${toolCheck.toolUsed}' detected. Fetching data...`);
        toolResult = toolCheck.data;
        conversationHistories[sessionId].history.push({ role: 'system', content: `Tool Output: ${toolResult}` });
    }

    let questionForOllama = userQuestion;
    conversationHistories[sessionId].history.push({ role: 'user', content: questionForOllama });
    console.log(`[CHAT] User message added to history. Current history length: ${conversationHistories[sessionId].history.length}`);

    try {
        console.log(`[CHAT] Calling Ollama /api/chat with model: ${OLLAMA_DEFAULT_MODEL}`);
        const response = await axios.post('http://localhost:11434/api/chat', {
            model: OLLAMA_DEFAULT_MODEL,
            messages: conversationHistories[sessionId].history,
            stream: false
        });

        let ollamaResponse = response.data.message.content;
        console.log(`[CHAT] Received raw response from Ollama. Length: ${ollamaResponse.length}. Content preview: "${ollamaResponse.substring(0, Math.min(ollamaResponse.length, 100))}"`);

        let fileTypeToGenerate = null;
        let generationPrompt = null;

        if (ollamaResponse.startsWith('CSV_REQUEST:')) {
            console.log("[CHAT] Ollama requested external CSV generation.");
            fileTypeToGenerate = 'csv';
            generationPrompt = ollamaResponse.substring('CSV_REQUEST:'.length).trim();
        } else if (ollamaResponse.startsWith('IMAGE_REQUEST:')) {
            console.log("[CHAT] Ollama requested external IMAGE generation.");
            fileTypeToGenerate = 'image';
            generationPrompt = ollamaResponse.substring('IMAGE_REQUEST:'.length).trim();
        } else {
            console.log("[CHAT] Ollama returned a textual response, no file generation requested.");
        }

        conversationHistories[sessionId].history.push({ role: 'assistant', content: ollamaResponse });
        console.log(`[CHAT] Ollama's response added to history. New history length: ${conversationHistories[sessionId].history.length}`);

        res.status(200).json({
            message: `✅ Chat response received`,
            answer: ollamaResponse,
            action: fileTypeToGenerate ? 'generate_file' : undefined,
            fileType: fileTypeToGenerate,
            generationPrompt: generationPrompt,
            sessionId: sessionId
        });
    } catch (error) {
        console.error("❌ [CHAT] Error during Ollama call:", error.message);
        if (error.response) {
            console.error("❌ [CHAT] Ollama API Response Data:", error.response.data);
            console.error("❌ [CHAT] Ollama API Response Status:", error.response.status);
        }
        conversationHistories[sessionId].history.pop();
        if (toolCheck.toolUsed) {
            conversationHistories[sessionId].history.pop();
        }
        res.status(500).json({
            message: '❌ Failed to get chat response',
            error: error.message,
            sessionId: sessionId
        });
    }
});

// ---  Function to open the browser ---
const openBrowser = (url) => {
    let command;
    switch (process.platform) {
        case 'darwin': // macOS
            command = `open ${url}`;
            break;
        case 'win32': // Windows
            command = `start ${url}`;
            break;
        case 'linux': // Linux
            command = `xdg-open ${url}`;
            break;
        default:
            console.warn(`Cannot auto-open browser on unsupported platform: ${process.platform}`);
            return;
    }
    exec(command, (err) => {
        if (err) {
            console.error(`❌ Failed to open browser with command "${command}":`, err.message);
        } else {
            console.log(`✅ Browser opened successfully with command: ${command}`);
        }
    });
};

// ---
// ## Endpoint to clear conversation history for a session
// ---
app.post('/clear-chat-history', (req, res) => {
    console.log(`\n--- Endpoint: /clear-chat-history ---`);
    const sessionId = req.body.sessionId;
    if (sessionId && conversationHistories[sessionId]) {
        delete conversationHistories[sessionId];
        console.log(`[CLEAR-CHAT-HISTORY] Cleared session: ${sessionId}`);
        res.status(200).json({ message: `✅ Conversation history cleared for session: ${sessionId}` });
    } else {
        console.warn(`[CLEAR-CHAT-HISTORY] Session not found or no ID provided: ${sessionId}`);
        res.status(404).json({ error: "❌ Session not found or no sessionId provided." });
    }
});


app.listen(port, () => {
    console.log(`\n🚀 Server running at http://localhost:${port}`);
    console.log(`Default Ollama Model (DeepSeek): ${OLLAMA_DEFAULT_MODEL}`);
    console.log(`Multimodal Model (LLaVA for image analysis): ${OLLAMA_MULTIMODAL_MODEL}`);
    console.log(`Endpoints:`);
    console.log(`   POST /analyze-csv        { csv, prompt, [sessionId] }`);
    console.log(`   POST /analyze-image      { image (base64), prompt, [sessionId] }`);
    console.log(`   POST /analyze-pdf        { pdf (base64), prompt, [sessionId] }`); // <--- NEW ENDPOINT
    console.log(`   POST /generate-csv       { prompt, [sessionId] }`);
   console.log(`   POST /generate-image     { prompt, [sessionId] }`);
    console.log(`   POST /chat               { question, [sessionId] }`);
    console.log(`   POST /clear-chat-history { sessionId }`);
    console.log(`\n--- Server Ready ---`);
    const url = `http://localhost:${port}`;
    console.log(`\nAttempting to open browser to: ${url}`);
    openBrowser(url);
});