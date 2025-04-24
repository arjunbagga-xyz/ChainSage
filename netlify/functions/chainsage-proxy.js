// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls to Gemini and Flipside Crypto using their SDK.
// It receives a question from the frontend, uses Gemini to
// generate SQL, executes the SQL on Flipside via the SDK, uses Gemini to summarize,
// and returns the summary.

// Import the Flipside SDK
const { Flipside } = require("@flipsidecrypto/sdk");

// Retrieve API keys from Netlify Environment Variables.
// These variables are set securely in your Netlify site settings.
// The names 'GEMINI_API' and 'FLIPSIDE_API' should match the names you set in Netlify.
const GEMINI_API_KEY = process.env.GEMINI_API;
const FLIPSIDE_API_KEY = process.env.FLIPSIDE_API;

// Basic validation to ensure keys are set during deployment/runtime
if (!GEMINI_API_KEY || !FLIPSIDE_API_KEY) {
    console.error("FATAL: API keys are not set as environment variables!");
    // In a real application, you might want more robust error handling here,
    // but for a serverless function, logging helps diagnose setup issues.
}

// Initialize Flipside SDK with the API key and the v2 API endpoint
const flipside = new Flipside(
    FLIPSIDE_API_KEY, // Pass the API key here
    "https://api-v2.flipsidecrypto.xyz" // Use the v2 API endpoint
);


// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash'; // Or gemini-1.5-flash for potentially lower cost/higher context
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// --- Recommended Settings for API Calls to Gemini ---
// Settings for converting NL to SQL
const SQL_GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.05,
  candidateCount: 1,
};

// Settings for summarizing data
const SUMMARIZATION_CONFIG = {
  temperature: 0.7, // Allow some creativity for summary
  topP: 0.9,
  candidateCount: 1
};

// --- Helper Function for Making API Calls from the Backend (Used only for Gemini now) ---
// This function centralizes fetching logic and error handling.
async function fetchApi(url, options, serviceName) {
    let response;
    try {
        console.log(`Calling external API: ${serviceName} - ${url}`);

        // Add a default User-Agent header (good practice)
        const defaultHeaders = {
            'User-Agent': 'ChainSage-Netlify-Function/1.0', // Identify your application
            ...options.headers // Merge with any specific headers provided
        };

        const fetchOptions = {
            ...options,
            headers: defaultHeaders
        };

        response = await fetch(url, fetchOptions);

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
            const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody.message || errorBody.error || response.statusText || 'Unknown error'}`;
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


// --- Core Workflow Functions ---

// Converts natural language question to SQL using Gemini API
// (This function remains the same, generating general SQL)
async function convertNLtoSQL(question) {
  const prompt = `
    You are an expert SQL writer specializing in blockchain data analysis.
    Your task is to convert the following natural language question into a concise SQL query.
    Focus on identifying the core data needed (e.g., balances, transactions, NFT data, volume).
    Assume a standard blockchain data schema with tables like 'trades', 'transfers', 'balances', 'prices', etc.
    Prioritize common blockchain data patterns (e.g., SELECT balance FROM balances WHERE address = ..., SELECT amount FROM transfers WHERE token = ...).
    Include necessary filters like 'block_timestamp' or 'block_time' for time ranges if specified in the question. Use common table names like 'ethereum.core.fact_transactions', 'ethereum.core.fact_token_transfers', 'erc20.tokens' etc., which are common on platforms like Flipside.

    Instructions:
    1. Analyze the question to understand the data needed.
    2. Construct a simple, standard SQL query representing the data request, using common blockchain table names.
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


// Executes the SQL query using the Flipside SDK
async function executeFlipsideQueryWithSDK(sqlQuery) {
    console.log(`Executing Flipside query via SDK: ${sqlQuery}`);
    try {
        // Use the SDK's query.run method
        const queryResultSet = await flipside.query.run({ sql: sqlQuery });

        // The result set contains metadata and the actual data rows
        console.log("Flipside SDK Query Executed. Status:", queryResultSet.status);
        console.log("Flipside SDK Query Result Count:", queryResultSet.records ? queryResultSet.records.length : 0);

        // Return the records (data rows)
        return queryResultSet.records || []; // Return empty array if no records
    } catch (error) {
        console.error('Error executing Flipside query via SDK:', error);
        // The SDK throws errors for API issues, query failures, etc.
        throw new Error(`Flipside SDK query execution failed: ${error.message}`);
    }
}


// Summarizes the Flipside data using Gemini API
// This function is similar, but takes data from the SDK result
async function summarizeFlipsideData(flipsideData, originalQuestion) {
  let dataToSend = flipsideData;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(flipsideData);

  // Simple sampling if data is too large for the prompt
  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    // Sample the data - assuming flipsideData is an array of rows from SDK
    if (Array.isArray(flipsideData)) {
         dataToSend = flipsideData.slice(0, Math.min(flipsideData.length, 50));
    } else {
         dataToSend = jsonData.substring(0, MAX_DATA_LENGTH) + "..."; // Fallback for non-array data
    }
  }

   if (!dataToSend || (Array.isArray(dataToSend) && dataToSend.length === 0)) {
      return "The query ran successfully on Flipside but returned no data.";
  }


  const prompt = `
    You are an insightful data analyst specializing in blockchain data.
    A user asked the following question: "${originalQuestion}"
    Data was retrieved from a Flipside Crypto query execution. Here is the relevant data (potentially sampled if large):
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
    let flipsideData = null;
    let finalInsight = "An unexpected error occurred."; // Default error message
    let statusCode = 500; // Default status code for errors

    try {
        // 1. Convert NL to SQL using Gemini
        sqlQuery = await convertNLtoSQL(question);
        console.log("Step 1: NL to SQL completed.");

        // 2. Execute the SQL query using the Flipside SDK
        // The SDK handles submission, polling, and fetching results internally
        flipsideData = await executeFlipsideQueryWithSDK(sqlQuery);
        console.log("Step 2 & 3 & 4: Flipside Query Executed and Results Fetched via SDK.");

        // 5. Summarize Flipside Data using Gemini
        finalInsight = await summarizeFlipsideData(flipsideData, question);
        console.log("Step 5: Summarization Completed.");

        statusCode = 200; // Success

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
            // rawFlipsideData: flipsideData // Be cautious with large data
        }),
    };
};
