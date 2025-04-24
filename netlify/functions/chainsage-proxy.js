// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls to Gemini and Flipside Crypto (ShroomDK).
// It receives a question from the frontend, uses Gemini to
// generate SQL, executes the SQL on Flipside, uses Gemini to summarize,
// and returns the summary.

// Netlify's Node.js environment supports native fetch
// const fetch = require('node-fetch'); // Uncomment if using node-fetch locally or on older Node

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

// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash'; // Or gemini-1.5-flash for potentially lower cost/higher context
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FLIPSIDE_API_BASE_URL = 'https://api-v2.flipsidecrypto.xyz'; // Flipside ShroomDK API Base URL

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

// --- Flipside Specific Configuration ---
const FLIPSIDE_EXECUTION_POLL_INTERVAL = 3000; // Shorter poll interval for Flipside
const FLIPSIDE_EXECUTION_MAX_WAIT_TIME = 120000; // Increased timeout for Flipside queries (2 minutes)


// --- Helper Function for Making API Calls from the Backend ---
// This function centralizes fetching logic and error handling.
async function fetchApi(url, options, serviceName) {
    let response;
    try {
        console.log(`Calling external API: ${serviceName} - ${url}`);

        // Add a default User-Agent header
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


// --- Flipside Crypto (ShroomDK) Workflow Functions ---

// Converts natural language question to SQL using Gemini API
// (This function remains the same as before, generating general SQL)
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

// Submits the SQL query to Flipside ShroomDK for execution
async function submitFlipsideQuery(sqlQuery) {
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // API Key is passed in the body for ShroomDK v1
        },
        body: JSON.stringify({
            sql: sqlQuery,
            apiKey: FLIPSIDE_API_KEY, // API Key included in the body for this endpoint
        }),
    };
    // Endpoint for submitting query execution
    const data = await fetchApi(`${FLIPSIDE_API_BASE_URL}/shroomdk/v1/exec`, options, 'Flipside (Submit Query)');

    // Flipside returns a query_id upon successful submission
    if (!data || !data.query_id) {
        console.error("Invalid response from Flipside submit:", data);
        throw new Error("Failed to submit query to Flipside: Invalid response.");
    }

    console.log("Flipside Query Submitted, ID:", data.query_id);
    return data.query_id;
}

// Gets the status of a Flipside query execution
async function getFlipsideQueryStatus(queryId) {
    const options = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
             // API Key is passed in the body for ShroomDK v1 status check
        },
         // API Key included in the body for this endpoint
        body: JSON.stringify({ apiKey: FLIPSIDE_API_KEY }), // Yes, body for GET status check in v1
    };
     // Endpoint for checking query status
    const response = await fetch(`${FLIPSIDE_API_BASE_URL}/shroomdk/v1/status?query_id=${queryId}`, options);

     if (!response.ok) {
        console.error(`Error fetching Flipside status for ${queryId}: ${response.status} ${response.statusText}`);
         let errorBody = await response.text();
         console.error("Flipside Status Error Body:", errorBody);
        throw new Error(`Failed to get Flipside execution status (${response.status})`);
    }
    const data = await response.json();
    // Flipside status is in data.status
    return data.status; // e.g., 'running', 'finished', 'failed'
}


// Waits for a Flipside query execution to complete, with timeout
async function waitForFlipsideExecution(queryId) {
  const startTime = Date.now();
  console.log(`Waiting for Flipside execution ${queryId} to complete...`);

  while (true) {
    // Check for timeout
    if (Date.now() - startTime > FLIPSIDE_EXECUTION_MAX_WAIT_TIME) {
      console.error(`Flipside query execution ${queryId} timed out.`);
      throw new Error(`Flipside query execution timed out after ${FLIPSIDE_EXECUTION_MAX_WAIT_TIME / 1000} seconds.`);
    }

    try {
      const status = await getFlipsideQueryStatus(queryId);
      console.log(`Flipside Execution ${queryId} status: ${status}`); // Log status for debugging

      switch (status) {
        case 'finished': // Flipside status for completion
          console.log(`Flipside Execution ${queryId} completed successfully.`);
          return true; // Success
        case 'failed': // Flipside status for failure
          console.error(`Flipside Execution ${queryId} failed.`);
          // Attempt to get error details if possible (might require fetching results or checking logs)
          throw new Error(`Flipside query execution failed.`); // Terminal state
        case 'running': // Flipside status for in progress
        case 'pending': // Flipside status for queued
          // Continue polling
          break; // Explicitly break the switch to continue the loop
        default:
          console.warn(`Unknown Flipside execution status encountered for ${queryId}: ${status}`);
          // Decide how to handle unknown states.
          throw new Error(`Encountered unknown Flipside execution status: ${status}`); // Treat as fatal for now
      }
    } catch (error) {
       console.error(`Error during polling for Flipside execution ${queryId}:`, error);
       // If getFlipsideQueryStatus throws, re-throw to break the wait loop
       throw new Error(`Polling error for Flipside execution ${queryId}: ${error.message}`);
    }

    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, FLIPSIDE_EXECUTION_POLL_INTERVAL));
  }
}


// Gets the results of a completed Flipside query execution
async function getFlipsideQueryResults(queryId) {
   const options = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
             // API Key is passed in the body for ShroomDK v1 results fetch
        },
         // API Key included in the body for this endpoint
        body: JSON.stringify({ apiKey: FLIPSIDE_API_KEY }), // Yes, body for GET results fetch in v1
    };
    // Endpoint for fetching query results
    const data = await fetchApi(`${FLIPSIDE_API_BASE_URL}/shroomdk/v1/results?query_id=${queryId}`, options, 'Flipside (Get Results)');

    // Flipside results are typically in data.results
    if (data && data.results) {
        console.log(`Successfully fetched ${data.results.length} rows from Flipside.`);
        // Flipside results might include column names and row data separately or combined.
        // For simplicity, we'll return the raw results structure.
        // You might need to adjust how you pass this to Gemini if the format is complex.
        return data.results;
    } else {
        console.warn("Flipside response did not contain expected 'results' property:", data);
        return []; // Return empty array if no results found
    }
}


// Summarizes the Flipside data using Gemini API
async function summarizeFlipsideData(flipsideData, originalQuestion) {
  let dataToSend = flipsideData;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(flipsideData);

  // Simple sampling if data is too large for the prompt
  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    // Sample the data - assuming flipsideData is an array of rows
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

  if (!result.candidates || result.candidates.length === 0 || !result[0].content || !result[0].content.parts || result[0].content.parts.length === 0) {
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
    let queryId = null;
    let flipsideData = null;
    let finalInsight = "An unexpected error occurred."; // Default error message
    let statusCode = 500; // Default status code for errors

    try {
        // 1. Convert NL to SQL using Gemini
        sqlQuery = await convertNLtoSQL(question);
        console.log("Step 1: NL to SQL completed.");

        // 2. Submit the SQL query to Flipside
        queryId = await submitFlipsideQuery(sqlQuery);
        console.log("Step 2: Flipside Query Submitted.");

        // 3. Wait for Flipside execution to complete
        await waitForFlipsideExecution(queryId);
        console.log("Step 3: Flipside Execution Completed.");

        // 4. Get the results from Flipside
        flipsideData = await getFlipsideQueryResults(queryId);
        console.log("Step 4: Flipside Results Fetched.");

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
            // queryId: queryId,
            // rawFlipsideData: flipsideData // Be cautious with large data
        }),
    };
};
