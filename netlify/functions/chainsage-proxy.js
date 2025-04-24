// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls to Gemini and Covalent Goldrush.
// It receives a question from the frontend, uses Gemini to
// generate SQL, then uses Gemini again to map SQL to Covalent
// API calls, executes Covalent calls, uses Gemini to summarize,
// and returns the summary.

// Netlify's Node.js environment supports native fetch
// const fetch = require('node-fetch'); // Uncomment if using node-fetch locally or on older Node

// Retrieve API keys from Netlify Environment Variables.
// These variables are set securely in your Netlify site settings.
// The names 'GEMINI_API' and 'COVALENT_API' should match the names you set in Netlify.
const GEMINI_API_KEY = process.env.GEMINI_API;
const COVALENT_API_KEY = process.env.COVALENT_API; // Renamed from DUNE_API

// Basic validation to ensure keys are set during deployment/runtime
if (!GEMINI_API_KEY || !COVALENT_API_KEY) {
    console.error("FATAL: API keys are not set as environment variables!");
    // In a real application, you might want more robust error handling here,
    // but for a serverless function, logging helps diagnose setup issues.
}

// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash'; // Or gemini-1.5-flash for potentially lower cost/higher context
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const COVALENT_API_BASE_URL = 'https://api.covalenthq.com'; // Covalent Goldrush API Base URL

// --- Recommended Settings for API Calls to Gemini ---
// Settings for converting NL to SQL
const SQL_GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.05,
  candidateCount: 1,
};

// Settings for mapping SQL to Covalent API calls
const COVALENT_MAPPING_CONFIG = {
    temperature: 0.1, // Keep low for predictable mapping
    topP: 0.1,
    candidateCount: 1,
};

// Settings for summarizing data
const SUMMARIZATION_CONFIG = {
  temperature: 0.7, // Allow some creativity for summary
  topP: 0.9,
  candidateCount: 1
};

// --- Helper Function for Making API Calls from the Backend ---
// This function centralizes fetching logic and error handling.
async function fetchApi(url, options, serviceName) {
    let response;
    try {
        console.log(`Calling external API: ${serviceName} - ${url}`);
        response = await fetch(url, options);

        if (!response.ok) {
            let errorBody = 'Could not parse error response.';
            try {
                // Attempt to parse JSON error body first
                errorBody = await response.json();
                console.error(`${serviceName} Error Response Body:`, errorBody);
            } catch (e) {
                // If JSON parsing fails, get response text
                errorBody = await response.text();
                console.error(`${serviceName} Error Response Text:`, errorBody);
            }

            // Construct a detailed error message
            const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody.error || errorBody.message || response.statusText || 'Unknown error'}`;
            console.error(`API call failed to ${serviceName}:`, errorMessage);

            // Include status code and service name in the error object for specific handling
            const apiError = new Error(errorMessage);
            apiError.status = response.status;
            apiError.service = serviceName;
            apiError.body = errorBody; // Attach the parsed body/text for inspection
            throw apiError;
        }

        const data = await response.json();
        console.log(`Successfully called ${serviceName}`);
        return data;

    } catch (error) {
        console.error(`Fetch error during call to ${serviceName}:`, error);
        // Re-throw the error with context and original error properties
        if (error.service) { // If it's an API error we already processed
             throw error;
        }
        // Otherwise, wrap a general fetch error
        const fetchErr = new Error(`API call failed to ${serviceName}: ${error.message}`);
        fetchErr.originalError = error; // Keep original error for debugging
        throw fetchErr;
    }
}


// --- Core Workflow Functions (Called by the main handler) ---

// Converts natural language question to SQL using Gemini API
async function convertNLtoSQL(question) {
  const prompt = `
    You are an expert SQL writer specializing in blockchain data analysis.
    Your task is to convert the following natural language question into a concise SQL query.
    Focus on identifying the core data needed (e.g., balances, transactions, NFT data, volume).
    Do NOT assume a specific database schema like Dune or Flipside. Just provide a general SQL representation of the data request.
    Prioritize common blockchain data patterns (e.g., SELECT balance FROM accounts WHERE address = ..., SELECT amount FROM transfers WHERE token = ...).

    Instructions:
    1. Analyze the question to understand the data needed.
    2. Construct a simple, general SQL query representing the data request.
    3. Output ONLY the raw SQL query. No explanations, comments, or markdown.
    4. If the question is too complex or ambiguous for a simple data query, output: "ERROR: Cannot formulate query".

    Natural Language Question:
    "${question}"

    SQL Query:
  `;

  const options = {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: SQL_GENERATION_CONFIG
      }),
  };

  const data = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (NL to SQL)');

  if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
      console.error("Invalid response structure from Gemini (NL to SQL):", data);
      throw new Error('Received invalid response structure from Gemini (NL to SQL).');
  }

  let sqlQuery = data.candidates[0].content.parts[0].text.trim();

  // Clean up potential markdown code blocks
  sqlQuery = sqlQuery.replace(/^```sql\s*/i, '').replace(/```$/, '').trim();

  if (sqlQuery.startsWith("ERROR:") || sqlQuery.length < 5) { // Basic check for errors or trivial responses
      throw new Error(`Gemini could not formulate a SQL query for the question.`);
  }

  console.log("Generated SQL:", sqlQuery);
  return sqlQuery;
}

// Uses Gemini to map the generated SQL to a Covalent API call
async function mapSQLtoCovalentApi(sqlQuery, originalQuestion) {
    // NOTE: This prompt requires Gemini to understand Covalent's API structure.
    // The accuracy of this mapping depends heavily on Gemini's training data
    // and the specificity of the prompt. You might need to refine this prompt
    // significantly based on testing.
    const prompt = `
    Analyze the following SQL query, which represents a user's blockchain data request.
    Your goal is to identify the core data being requested (e.g., token balances, NFT transfers, transactions for an address, historical prices) and map it to the most relevant Covalent Goldrush API endpoint(s).
    Provide the endpoint path and necessary parameters in a structured JSON format.
    If the SQL query cannot be mapped to a suitable Covalent endpoint, return a specific JSON indicating this.

    Covalent Goldrush API Documentation Overview: ${COVALENT_API_BASE_URL}/docs/api/

    Common Covalent Endpoints (Examples - refer to full docs for details):
    - Get token balances for address: /v1/{chain_id}/address/{address}/balances_v2/
    - Get historical transactions for address: /v2/{chain_id}/address/{address}/transactions_v2/
    - Get NFT transfers for contract: /v2/{chain_id}/nft/{contract_address}/token/{token_id}/transactions/ (for specific token ID)
    - Get all NFT transfers for contract: /v2.{chain_id}/nft/{contract_address}/transactions/ (requires pagination handling)
    - Get historical prices for token: /v1/pricing/historical_by_token_ids_v2/{chain_id}/latest/

    Instructions:
    1. Analyze the provided SQL query and the original natural language question.
    2. Determine the most appropriate Covalent API endpoint(s) to fulfill the request.
    3. Identify the required parameters (chain_id, address, contract_address, token_id, etc.) from the SQL or original question. Make reasonable assumptions if parameters are missing (e.g., assume Ethereum if chain is not specified, use a placeholder like 'USER_ADDRESS_PLACEHOLDER' if an address is needed but not provided).
    4. Format the output as a JSON object with the following structure:
       {
         "endpoint": "string", // The Covalent API path (e.g., "/v1/1/address/0x.../balances_v2/")
         "method": "GET" | "POST", // HTTP method (most Covalent endpoints are GET)
         "parameters": { // Object containing key-value pairs for query parameters or path segments
           "chain_id": "string", // e.g., "1", "137", "eth-mainnet", "matic-mainnet"
           // ... other parameters like "address", "contract-address", "token-id", "quote-currency", "from", "to", "page-size", "page-number"
         },
         "requires_address": boolean, // Set to true if an address is mandatory but not in the query/question
         "requires_contract": boolean, // Set to true if a contract address is mandatory but not in the query/question
         "requires_token_id": boolean, // Set to true if a token ID is mandatory but not in the query/question
         "description": "string" // Brief description of the intended Covalent call
       }
    5. If the SQL query cannot be mapped to a suitable Covalent endpoint, return:
       {
         "error": "Cannot map query to Covalent endpoint",
         "description": "The request type is not directly supported by the available Covalent API endpoints."
       }
    6. Ensure the JSON is valid and contains ONLY the JSON object. Do not include markdown formatting (\`\`\`json) or any other text.

    Original Question: "${originalQuestion}"
    SQL Query: "${sqlQuery}"

    Covalent API Mapping:
    `;

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: COVALENT_MAPPING_CONFIG,
        }),
    };

    const data = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (SQL to Covalent Mapping)');

    if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
        console.error("Invalid response structure from Gemini (Mapping):", data);
        throw new Error('Received invalid response structure from Gemini (SQL to Covalent Mapping).');
    }

    let jsonString = data.candidates[0].content.parts[0].text.trim();

     // Clean up potential markdown code blocks if the model adds them
    jsonString = jsonString.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    try {
        const mapping = JSON.parse(jsonString);
        console.log("Covalent Mapping:", mapping);
        if (mapping.error) {
             throw new Error(`Mapping failed: ${mapping.description || mapping.error}`);
        }
         if (!mapping.endpoint || !mapping.method || !mapping.parameters) {
             throw new Error("Mapping returned invalid structure.");
         }
        return mapping;
    } catch (e) {
        console.error("Failed to parse Gemini mapping response:", jsonString, e);
        throw new Error(`Failed to interpret Covalent API mapping from Gemini. Response: ${jsonString.substring(0, 200)}...`);
    }
}


// Executes the Covalent API call based on the mapping
async function executeCovalentApiCall(mapping) {
    let url = `${COVALENT_API_BASE_URL}${mapping.endpoint}`;
    const options = {
        method: mapping.method,
        headers: {
             // Covalent API key is passed as a query parameter
        },
    };

    // Add query parameters from the mapping, including the API key
    const queryParams = new URLSearchParams(mapping.parameters);
    queryParams.set('key', COVALENT_API_KEY); // Add API key securely

    url = `${url}?${queryParams.toString()}`;

    // NOTE: Covalent API has pagination for some endpoints (e.g., NFT transfers).
    // This simple implementation doesn't handle pagination. For production,
    // you might need to detect paginated endpoints and fetch multiple pages.

    const data = await fetchApi(url, options, `Covalent (${mapping.description || mapping.endpoint})`);

    // Covalent responses have a common structure, often with a 'data' property
    if (data && data.data) {
        console.log("Covalent Data Received:", data.data);
        return data.data; // Return the relevant data part
    } else {
        console.warn("Covalent response did not contain expected 'data' property:", data);
        return data; // Return raw response if structure is unexpected
    }
}

// Summarizes the Covalent data using Gemini API
async function summarizeCovalentData(covalentData, originalQuestion) {
  let dataToSend = covalentData;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(covalentData);

  // Simple sampling if data is too large for the prompt
  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    // Sample the data - this might need refinement based on data structure
    if (Array.isArray(covalentData.items)) {
         dataToSend = { ...covalentData, items: covalentData.items.slice(0, Math.min(covalentData.items.length, 50)) };
    } else {
         dataToSend = jsonData.substring(0, MAX_DATA_LENGTH) + "..."; // Fallback for non-array data
    }
  }

  if (!dataToSend || (Array.isArray(dataToSend.items) && dataToSend.items.length === 0)) {
      return "The query ran successfully but returned no data from Covalent.";
  }

  const prompt = `
    You are an insightful data analyst specializing in blockchain data.
    A user asked the following question: "${originalQuestion}"
    Data was retrieved from the Covalent Goldrush API. Here is the relevant data (potentially sampled if large):
    ${JSON.stringify(dataToSend, null, 2)}

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
          generationConfig: SUMMARIZATION_CONFIG
      }),
  };

  const result = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (Summarization)');

  if (!result.candidates || result.candidates.length === 0 || !result.candidates[0].content || !result.candidates[0].content.parts || result.candidates[0].content.parts.length === 0) {
      console.error("Invalid response structure from Gemini (Summarization):", result);
      throw new Error('Received invalid response structure from Gemini during summarization.');
  }

  const insight = result.candidates[0].content.parts[0].text.trim();
  console.log("Generated Insight:", insight);
  return insight;
}


// --- Netlify Function Handler ---
// This is the entry point for the Netlify Function.
// It receives the HTTP request and returns the HTTP response.
exports.handler = async function(event, context) {
    // Log the incoming request details
    console.log("Received request:", {
        httpMethod: event.httpMethod,
        path: event.path,
    });

    // Only allow POST requests from the frontend
    if (event.httpMethod !== "POST") {
        console.warn(`Method Not Allowed: ${event.httpMethod}`);
        return {
            statusCode: 405,
            body: "Method Not Allowed",
        };
    }

    // Parse the request body to get the user's question
    let question;
    try {
        const body = JSON.parse(event.body);
        question = body.question;
        // Basic validation of the question
        if (!question || typeof question !== 'string' || question.trim() === '') {
             console.warn("Bad Request: Invalid or missing 'question' in body.");
             return {
                statusCode: 400,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Invalid or missing 'question' in request body." }),
            };
        }
    } catch (error) {
        console.error("Error parsing request body:", error);
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Invalid JSON request body." }),
        };
    }

    console.log(`Processing question: "${question}"`);

    let sqlQuery = null;
    let covalentMapping = null;
    let covalentData = null;
    let finalInsight = "An unexpected error occurred."; // Default error message
    let statusCode = 500; // Default status code for errors

    try {
        // 1. Convert NL to SQL using Gemini
        sqlQuery = await convertNLtoSQL(question);
        console.log("Step 1: NL to SQL completed.");

        // 2. Map SQL to Covalent API call(s) using Gemini
        covalentMapping = await mapSQLtoCovalentApi(sqlQuery, question);
        console.log("Step 2: SQL to Covalent Mapping completed.");
        console.log("Mapped API Call:", covalentMapping);

        // --- Basic validation of mapping result ---
        if (covalentMapping.requires_address || covalentMapping.requires_contract || covalentMapping.requires_token_id) {
             // If Gemini indicates required parameters are missing, inform the user
             let missingParams = [];
             if(covalentMapping.requires_address) missingParams.push("a wallet address");
             if(covalentMapping.requires_contract) missingParams.push("a contract address");
             if(covalentMapping.requires_token_id) missingParams.push("a token ID");

             finalInsight = `The Oracle needs more information to answer that question. Please provide ${missingParams.join(' and ')}.`;
             statusCode = 200; // Return success status as we're providing information

        } else {
            // 3. Execute the Covalent API call
            covalentData = await executeCovalentApiCall(covalentMapping);
            console.log("Step 3: Covalent API Call executed.");

            // 4. Summarize Covalent Data using Gemini
            finalInsight = await summarizeCovalentData(covalentData, question);
            console.log("Step 4: Summarization Completed.");
            statusCode = 200; // Success
        }


    } catch (error) {
        // --- Handle Errors ---
        console.error('Error in Netlify function pipeline:', error);
        // Update the final insight to reflect the error
        finalInsight = `ChainSage Error: ${error.message}`;
        // Keep the status code as 500 for internal errors
        statusCode = 500;
    }

    // --- Return Response ---
    // The response body contains the final insight or the error message.
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            insight: finalInsight,
            // Optionally include intermediate steps for debugging if needed
            // sql: sqlQuery,
            // mapping: covalentMapping,
            // rawCovalentData: covalentData // Be cautious with large data
        }),
    };
};
