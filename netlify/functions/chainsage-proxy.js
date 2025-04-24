// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls to Gemini and Dune Analytics.
// It receives a question from the frontend, performs the
// Dune/Gemini workflow, and returns the summary.

// Netlify's Node.js environment supports native fetch
// const fetch = require('node-fetch'); // Uncomment if using node-fetch locally or on older Node

// Retrieve API keys from Netlify Environment Variables.
// These variables are set securely in your Netlify site settings.
// The names 'GEMINI_API' and 'DUNE_API' should match the names you set in Netlify.
const GEMINI_API_KEY = process.env.GEMINI_API;
const DUNE_API_KEY = process.env.DUNE_API;

// Basic validation to ensure keys are set during deployment/runtime
if (!GEMINI_API_KEY || !DUNE_API_KEY) {
    console.error("FATAL: API keys are not set as environment variables!");
    // In a real application, you might want more robust error handling here,
    // but for a serverless function, logging helps diagnose setup issues.
}

// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const DUNE_API_BASE_URL = 'https://api.dune.com/api/v1';

// --- Recommended Settings for Automated SQL Generation ---
const SQL_GENERATION_CONFIG = {
  temperature: 0.1, // Low temperature for predictability
  topP: 0.05,       // Very low topP to focus on most likely tokens
  candidateCount: 1,
};

// --- Recommended Settings for Summarization ---
const SUMMARIZATION_CONFIG = {
  temperature: 1,
  topP: 0.9,
  candidateCount: 1
};

const EXECUTION_POLL_INTERVAL = 5000; // Milliseconds
const EXECUTION_MAX_WAIT_TIME = 90000; // Milliseconds (Increased timeout for potentially long queries)


// --- Helper Function for Making API Calls from the Backend ---
// This function centralizes fetching logic and error handling.
async function fetchApi(url, options, serviceName) {
    try {
        console.log(`Calling external API: ${serviceName} - ${url}`);
        const response = await fetch(url, options);

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
            const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody.error?.message || errorBody.message || response.statusText || 'Unknown error'}`;
            console.error(`API call failed to ${serviceName}:`, errorMessage);
            throw new Error(errorMessage);
        }

        const data = await response.json();
        console.log(`Successfully called ${serviceName}`);
        return data;

    } catch (error) {
        console.error(`Fetch error during call to ${serviceName}:`, error);
        // Re-throw the error with context
        throw new Error(`API call failed to ${serviceName}: ${error.message}`);
    }
}


// --- Dune Analytics Workflow Functions (Called by the main handler) ---

// Converts natural language question to SQL using Gemini API (securely from backend)
async function convertNLtoSQL(question) {
  const prompt = `
    You are an expert SQL writer specializing in Dune Analytics (which uses Spark SQL / PostgreSQL syntax).
    Your task is to convert the following natural language question into a valid Dune SQL query.

    Instructions:
    1.  Analyze the question carefully to understand the user's intent.
    2.  Identify the relevant Dune tables (e.g., dex.trades, nft.trades, ethereum.transactions, etc.) and columns needed. Refer to Dune schema if necessary, but prioritize common tables.
    3.  Construct a syntactically correct Spark SQL / PostgreSQL query.
    4.  IMPORTANT: Output ONLY the raw SQL query. Do not include any explanations, comments, markdown formatting (like \`\`\`sql), or introductory phrases.
    5.  If the question is ambiguous or lacks necessary details (like specific contract addresses, date ranges, or chains), make reasonable assumptions (e.g., use Ethereum mainnet, a recent time range like 'last 7 days' if unspecified) BUT try your best to generate a usable query. If it's impossible to generate a meaningful query, output the text: "ERROR: Ambiguous question".

    Natural Language Question:
    "${question}"

    SQL Query:
  `;

  const options = {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          // API Key is added here on the server side using process.env
          'x-goog-api-key': GEMINI_API_KEY, // Correct header for Gemini REST API
      },
      body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: SQL_GENERATION_CONFIG
      }),
  };

  const data = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (SQL Generation)');

  // Validate response structure
  if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
      console.error("Invalid response structure from Gemini:", data);
      throw new Error('Received invalid response structure from Gemini.');
  }

  let sqlQuery = data.candidates[0].content.parts[0].text.trim();

  // Clean up potential markdown code blocks
  sqlQuery = sqlQuery.replace(/^```sql\s*/i, '').replace(/```$/, '').trim();

  // Basic check for error markers or trivial responses from the model
  if (sqlQuery.startsWith("ERROR:") || sqlQuery.length < 10) {
      throw new Error(`Gemini indicated an issue or returned a non-query response: ${sqlQuery}`);
  }

  console.log("Generated SQL:", sqlQuery);
  return sqlQuery;
}

// Creates a new query on Dune Analytics (securely from backend)
async function createDuneQuery(sqlQuery, question) {
  const options = {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'X-DUNE-API-KEY': DUNE_API_KEY, // API Key is added here on the server side
      },
      body: JSON.stringify({
          name: `ChainSage Query - ${new Date().toISOString()}`,
          description: `Generated by ChainSage for question: ${question}`,
          query_sql: sqlQuery,
          is_private: true, // Keep generated queries private
      }),
  };
  const data = await fetchApi(`${DUNE_API_BASE_URL}/query`, options, 'Dune (Create Query)');
  console.log("Dune Query Created, ID:", data.query_id);
  return data.query_id;
}

// Executes a query on Dune Analytics (securely from backend)
async function executeDuneQuery(queryId) {
  const options = {
      method: 'POST',
      headers: {
          'X-DUNE-API-KEY': DUNE_API_KEY, // API Key is added here on the server side
          'Content-Type': 'application/json',
      },
      // Optional: Add performance tier if needed: body: JSON.stringify({ performance: 'medium' })
  };
  const data = await fetchApi(`${DUNE_API_BASE_URL}/query/${queryId}/execute`, options, 'Dune (Execute Query)');
  console.log("Dune Query Execution Started, Execution ID:", data.execution_id);
  return data.execution_id;
}

// Gets the status of an execution on Dune Analytics (securely from backend)
async function getExecutionStatus(executionId) {
  const options = {
      method: 'GET',
      headers: {
          'X-DUNE-API-KEY': DUNE_API_KEY, // API Key is added here on the server side
      },
  };
  // Use fetch directly here because we only care about the status state,
  // and a non-200 response might indicate a valid state like FAILED.
  // The waitForExecution logic handles the state interpretation.
  const response = await fetch(`${DUNE_API_BASE_URL}/execution/${executionId}/status`, options);

  if (!response.ok) {
      // Log the error but don't throw immediately, let waitForExecution handle it
      console.error(`Error fetching status for ${executionId}: ${response.status} ${response.statusText}`);
       // You might want to throw a specific error here if the status fetch itself fails critically
       // throw new Error(`Failed to fetch execution status (${response.status})`);
  }
  const data = await response.json();
  return data.state;
}

// Waits for a Dune execution to complete, with timeout
async function waitForExecution(executionId) {
  const startTime = Date.now();
  console.log(`Waiting for execution ${executionId} to complete...`);

  while (true) {
    // Check for timeout
    if (Date.now() - startTime > EXECUTION_MAX_WAIT_TIME) {
      console.error(`Query execution ${executionId} timed out.`);
      throw new Error(`Query execution timed out after ${EXECUTION_MAX_WAIT_TIME / 1000} seconds.`);
    }

    try {
      const state = await getExecutionStatus(executionId);
      console.log(`Execution ${executionId} state: ${state}`); // Log state for debugging

      switch (state) {
        case 'QUERY_STATE_COMPLETED':
          console.log(`Execution ${executionId} completed successfully.`);
          return true; // Success
        case 'QUERY_STATE_FAILED':
        case 'QUERY_STATE_CANCELLED':
          console.error(`Execution ${executionId} failed or was cancelled.`);
          throw new Error(`Query execution ${state.toLowerCase().replace('query_state_', '')}.`); // Terminal state
        case 'QUERY_STATE_EXECUTING':
        case 'QUERY_STATE_PENDING':
          // Continue polling
          break; // Explicitly break the switch to continue the loop
        default:
          console.warn(`Unknown execution state encountered for ${executionId}: ${state}`);
          // Decide how to handle unknown states. For robustness, maybe throw after a few attempts.
          throw new Error(`Encountered unknown execution state: ${state}`); // Treat as fatal for now
      }
    } catch (error) {
       console.error(`Error during polling for execution ${executionId}:`, error);
       // If getExecutionStatus throws, re-throw to break the wait loop
       throw new Error(`Polling error for execution ${executionId}: ${error.message}`);
    }

    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, EXECUTION_POLL_INTERVAL));
  }
}


// Gets the results of a completed Dune execution (securely from backend)
async function getExecutionResults(executionId) {
  const options = {
      method: 'GET',
      headers: {
          'X-DUNE-API-KEY': DUNE_API_KEY, // API Key is added here on the server side
      },
      // Optional: Add limit/offset for pagination if needed
      // query parameters: ?limit=100&offset=0
  };
  const data = await fetchApi(`${DUNE_API_BASE_URL}/execution/${executionId}/results`, options, 'Dune (Get Results)');

  if (data.result && data.result.rows) {
      console.log(`Successfully fetched ${data.result.rows.length} rows.`);
      return data.result.rows;
  } else {
      console.warn(`Execution results format unexpected for ${executionId}:`, data);
      return []; // Return empty array if no rows found
  }
}

// Summarizes data using Gemini API (securely from backend)
async function summarizeData(data, originalQuestion) {
  let dataToSend = data;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(data);

  // Simple sampling if data is too large for the prompt
  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    dataToSend = data.slice(0, Math.min(data.length, 50)); // Example: summarize first 50 rows
  }

  if (dataToSend.length === 0) {
      return "The query ran successfully but returned no data.";
  }

  const prompt = `
    You are an insightful data analyst.
    A user asked the following question: "${originalQuestion}"
    A Dune Analytics query was run and returned the following data (potentially sampled if large):
    ${JSON.stringify(dataToSend)}

    Based on this data and the original question, provide a concise and easy-to-understand summary or insight.
    Focus on answering the user's original question using the data.
    If the data doesn't directly answer the question, state that and summarize what the data DOES show.
    Keep the summary brief (2-3 sentences).
  `;

  const options = {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY, // API Key is added here on the server side
      },
      body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: SUMMARIZATION_CONFIG
      }),
  };

  const result = await fetchApi(GEMINI_API_BASE_URL, options, 'Gemini (Summarization)');

  // Validate response structure
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
    // Log the incoming request details (useful for debugging on Netlify)
    console.log("Received request:", {
        httpMethod: event.httpMethod,
        path: event.path,
        // body: event.body // Be cautious logging sensitive info
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

    // --- Execute the full pipeline using the backend functions ---
    let finalInsight = "An unexpected error occurred."; // Default error message
    let statusCode = 500; // Default status code for errors

    try {
        // 1. Convert NL to SQL
        const sqlQuery = await convertNLtoSQL(question);
        console.log("Step 1: NL to SQL completed.");

        // 2. Create Dune Query
        const queryId = await createDuneQuery(sqlQuery, question);
        console.log("Step 2: Dune Query Created.");

        // 3. Execute Dune Query
        const executionId = await executeDuneQuery(queryId);
        console.log("Step 3: Dune Execution Started.");

        // 4. Wait for Completion
        await waitForExecution(executionId);
        console.log("Step 4: Dune Execution Completed.");

        // 5. Get Results
        const results = await getExecutionResults(executionId);
        console.log("Step 5: Dune Results Fetched.");

        // 6. Summarize Results
        finalInsight = await summarizeData(results, question);
        console.log("Step 6: Summarization Completed.");

        // If all steps succeed, set success status code
        statusCode = 200;

    } catch (error) {
        console.error('Error in Netlify function pipeline:', error);
        // Update the final insight to reflect the error
        finalInsight = `ChainSage Error: ${error.message}`;
        // Keep the status code as 500 (Internal Server Error) for uncaught errors
        // Specific API errors handled within fetchApi might throw errors with messages
        // that are appropriate to return to the user.
    }

    // --- Return Response ---
    // The response body contains the final insight or the error message.
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            insight: finalInsight,
            // You could add a 'success: boolean' flag here if needed by the frontend
            // success: statusCode === 200
        }),
    };
};

