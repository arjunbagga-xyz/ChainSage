// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls, now to Modula instead of Gemini and Flipside.
// It receives a question from the frontend, uses Gemini to
// determine the appropriate Modula API endpoint and parameters,
// calls the Modula API, and uses Gemini to summarize the response.

// Netlify's Node.js environment supports native fetch
// const fetch = require('node-fetch'); // Uncomment if using node-fetch locally

// Retrieve API keys from Netlify Environment Variables.
const GEMINI_API_KEY = process.env.GEMINI_API;
const MODULA_API_KEY = process.env.MODULA_API; // New: Modula API Key
const MODULA_API_BASE_URL = 'https://api.mobula.io/api'; // Define the base URL

// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// --- Recommended Settings for API Calls to Gemini ---
const NL_TO_ENDPOINT_CONFIG = { // Renamed for clarity
    temperature: 0.1,
    topP: 0.05,
    candidateCount: 1,
};

const SUMMARIZATION_CONFIG = {
    temperature: 0.7,
    topP: 0.9,
    candidateCount: 1,
};

// --- Helper Function for Making API Calls ---
async function fetchApi(url, options, serviceName) {
    let response;
    let responseBodyText = '';

    try {
        console.log(`Calling external API: ${serviceName} - ${url}`);

        const defaultHeaders = {
            'User-Agent': 'ChainSage-Netlify-Function/1.0',
        };

        if (serviceName === 'Modula' && MODULA_API_KEY) {
            defaultHeaders['Authorization'] =  MODULA_API_KEY;
        }

        const fetchOptions = {
            ...options,
            headers: {
                ...defaultHeaders,
                ...(options.headers || {}), // Merge any user-provided headers *after* our defaults
            },
        };

        response = await fetch(url, fetchOptions);
        responseBodyText = await response.text();

        if (!response.ok) {
            let errorBody;
            try {
                errorBody = JSON.parse(responseBodyText);
                console.error(`${serviceName} Error Response Body (Parsed):`, errorBody);
            } catch (e) {
                errorBody = responseBodyText;
                console.error(`${serviceName} Error Response Body (Raw Text):`, errorBody);
            }

            const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody?.message || errorBody?.error || responseBodyText || response.statusText || 'Unknown error'}`;
            console.error(`API call failed to ${serviceName}:`, errorMessage);

            const apiError = new Error(errorMessage);
            apiError.status = response.status;
            apiError.service = serviceName;
            apiError.body = errorBody;
            throw apiError;
        }

        const data = JSON.parse(responseBodyText);
        console.log(`Successfully called ${serviceName}`);
        return data;

    } catch (error) {
        console.error(`Fetch error during call to ${serviceName}:`, error);
         if (error.service) {
            throw error;
        }
        const fetchErr = new Error(`API call failed to ${serviceName}: ${error.message}${responseBodyText ? ` Body: ${responseBodyText.substring(0, 200)}...` : ''}`);
        fetchErr.originalError = error;
        throw fetchErr;
    }
}

// --- Modula API Interaction Functions ---

// 1.  Function to get the relevant Modula endpoint and extract parameters
async function getModulaEndpointAndParams(question, availableEndpoints) {
    const prompt = `
        You are an AI assistant designed to understand user questions about cryptocurrency data and identify the most appropriate API endpoint from a given list.
        
        Here is a list of available API endpoints with their descriptions and required parameters:
        ${JSON.stringify(availableEndpoints, null, 2)}
        
        Your task is to:
        1.  Analyze the user's question and determine the user's intent.
        2.  Identify the single most relevant endpoint(s) from the list above that can fulfill the user's request.
        3.  Extract any parameters mentioned in the user's question that match the 'required_parameters' of the identified endpoint(s).  The parameter names are case-sensitive.
        4.  Determine if a query is possible.
        5.  Generate a response, following these rules:
            * If a query is possible, return a JSON object containing the endpoint(s) and extracted parameters.
            * If a query is not possible, return a JSON object explaining why, what information is missing or what can the user ask instead.
        
        Example 1:
        User Question: "What is the price of Bitcoin?"
        
        Your Response:
        {
            "can_query": true,
            "endpoints": [
                {
                    "endpoint_group": "Octopus - Market API",
                    "name": "Get Market Data",
                    "extracted_parameters": {
                        "id": "bitcoin"
                    },
                    "required_parameters": ["id"],
                    "path": "/1/market/data"
                }
            ]
        }
        
        Example 2:
        User Question: "Show me the historical data"
        
        Your Response:
        {
            "can_query": false,
            "message": "Missing parameters: id, from, to.  Please specify the asset ID and the time range."
        }
        
         Example 3:
         User Question: "tell me about the top gainers in the last 24 hours"
         Your Response:
        {
            "can_query": false,
            "message": "I cannot answer this question with the available tools."
        }
        
        Analyze the following user question and provide your response as a JSON object:
        
        User Question: "${question}"
    `;

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: NL_TO_ENDPOINT_CONFIG,
        }),
    };

    const data = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (NL to Endpoint)');

    if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error("Invalid response structure from Gemini (NL to Endpoint):", data);
        throw new Error('Received invalid response structure from Gemini (NL to Endpoint).');
    }

    let geminiResponse;
    try {
        geminiResponse = JSON.parse(data.candidates[0].content.parts[0].text.trim());
    } catch (e) {
        console.error("Gemini output was not valid JSON:", data.candidates[0].content.parts[0].text.trim(), e);
        //  Attempt to remove the ```json ``` block, and try again.
        const cleanedText = data.candidates[0].content.parts[0].text.trim().replace(/```json\n([\s\S]*)\n```/g, '$1');
        try {
            geminiResponse = JSON.parse(cleanedText);
            console.log("Successfully parsed cleaned Gemini output.");
        }
        catch (e2) {
            throw new Error("Gemini output was not valid JSON.");
        }
    }
    return geminiResponse;
}



// 2. Function to call the Modula API
async function callModulaApi(endpoint, params) {
    const url = `${MODULA_API_BASE_URL}${endpoint.path}`; // Use the path from docs.json

    // Construct query parameters.
    const urlParams = new URLSearchParams();
    for (const key in params) {
        urlParams.append(key, params[key]);
    }
    const fullUrl = url + '?' + urlParams.toString();

    console.log("Modula API URL:", fullUrl); // Add this line

    const options = {
        method: 'GET', // All Modula endpoints in docs.json use GET
        headers: {
            //  'Content-Type': 'application/json', //removed this
        },
    };

    const data = await fetchApi(fullUrl, options, 'Modula');
    return data;
}


// 3. Function to summarize the data using Gemini
async function summarizeModulaData(modulaData, originalQuestion) {
    const dataToSend = JSON.stringify(modulaData);
    const prompt = `
        You are an insightful data analyst specializing in cryptocurrency data.
        A user asked the following question: "${originalQuestion}"
        Data was retrieved from the Modula API. Here is the relevant data:
        ${dataToSend}
        
        Based on this data and the original question, provide a concise and easy-to-understand summary or insight.
        Focus on answering the user's original question using the data provided.
        If the data doesn't directly answer the question, state that and summarize what the data DOES show.
        Keep the summary brief (2-3 sentences), unless more detail is necessary to answer the question based on the data.
        If the data indicates an error or no results, state that clearly.
    `;

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: SUMMARIZATION_CONFIG,
        }),
    };

    const result = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (Summarization)');

    if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error("Invalid response structure from Gemini (Summarization):", result);
        throw new Error('Received invalid response structure from Gemini during summarization.');
    }

    const insight = result.candidates[0].content.parts[0].text.trim();
    console.log("Generated Insight:", insight);
    return insight;
}

// --- Netlify Function Handler ---
exports.handler = async function (event, context) {
    console.log("Received request:", {
        httpMethod: event.httpMethod,
        path: event.path,
    });

    if (event.httpMethod !== 'POST') {
        console.warn(`Method Not Allowed: ${event.httpMethod}`);
        return {
            statusCode: 405,
            body: 'Method Not Allowed',
        };
    }

    let question;
    try {
        const body = JSON.parse(event.body);
        question = body.question;
        if (!question || typeof question !== 'string' || question.trim() === '') {
            console.warn("Bad Request: Invalid or missing 'question' in body.");
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Invalid or missing 'question' in request body." }),
            };
        }
    } catch (error) {
        console.error('Error parsing request body:', error);
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Invalid JSON request body.' }),
        };
    }

    console.log(`Processing question: "${question}"`);

    let finalInsight = "An unexpected error occurred.";
    let statusCode = 500;

    try {
        // 1. Get Modula endpoint and parameters
        const endpointData = await getModulaEndpointAndParams(question,  JSON.parse(JSON.stringify(require('./docs.json'))));
        console.log("Step 1: Endpoint and Parameters determined:", endpointData);

        // 2.  Check if we can query.  If not, return to user.
        if (!endpointData.can_query) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ insight: endpointData.message }), // Return the message from LLM
            };
        }
        // 3. Call Modula API (if query is possible)
        const modulaResponse = await callModulaApi(endpointData.endpoints[0], endpointData.endpoints[0].extracted_parameters);  //changed from endpointData to endpointData.endpoints[0]
        console.log("Step 2: Modula API called successfully.");

        // 4. Summarize the data
        finalInsight = await summarizeModulaData(modulaResponse, question);
        console.log("Step 3: Data summarized.");
        statusCode = 200;

    } catch (error) {
        console.error('Error in Netlify function pipeline:', error);
        finalInsight = `ChainSage Error: ${error.message}`;
        statusCode = 500;
    }

    return {
        statusCode: statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            insight: finalInsight,
        }),
    };
};
