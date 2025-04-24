// This Netlify Serverless Function acts as a backend proxy
// to securely handle API calls to Gemini and Flipside Crypto (V2 JSON-RPC).
// It receives a question from the frontend, uses Gemini to
// generate SQL, executes the SQL on Flipside via JSON-RPC, uses Gemini to summarize,
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
    console.error("FATAL: Required API keys (GEMINI_API, FLIPSIDE_API) are not set as environment variables!");
    // In a real application, you might want more robust error handling here,
    // but for a serverless function, logging helps diagnose setup issues.
}

// --- API Configuration ---
const GEMINI_MODEL = 'gemini-2.0-flash'; // Or gemini-1.5-flash for potentially lower cost/higher context
const GEMINI_API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Correct Flipside V2 JSON-RPC API Endpoint
const FLIPSIDE_API_ENDPOINT = 'https://api-v2.flipsidecrypto.xyz/json-rpc';

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
const FLIPSIDE_RESULTS_PAGE_SIZE = 1000; // How many rows to fetch per results page

// --- Helper Function for Making API Calls from the Backend ---
// This function centralizes fetching logic and error handling.
async function fetchApi(url, options, serviceName) {
    let response;
    let responseBodyText = ''; // Variable to store the response body as text

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

        // Read the response body ONCE as text
        responseBodyText = await response.text();

        if (!response.ok) {
            let errorBody;
            try {
                // Attempt to parse the already read text as JSON
                errorBody = JSON.parse(responseBodyText);
                console.error(`${serviceName} Error Response Body (Parsed):`, errorBody);
            } catch (e) {
                // If JSON parsing fails, use the raw text
                errorBody = responseBodyText;
                console.error(`${serviceName} Error Response Body (Raw Text):`, errorBody);
            }

            // Construct a detailed error message
            // Try to get a message from the parsed body, fallback to raw text or status text
            const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody?.message || errorBody?.error || responseBodyText || response.statusText || 'Unknown error'}`;
            console.error(`API call failed to ${serviceName}:`, errorMessage);

            // Include status code and service name in the error object for specific handling
            const apiError = new Error(errorMessage);
            apiError.status = response.status;
            apiError.service = serviceName;
            apiError.body = errorBody; // Attach the parsed body/text for inspection
            throw apiError;
        }

        // If response is OK, parse the already read text as JSON
        const data = JSON.parse(responseBodyText);
        console.log(`Successfully called ${serviceName}`);

        // Check for JSON-RPC specific errors in the response body
        if (data.error) {
            const jsonRpcError = new Error(`JSON-RPC Error ${data.error.code}: ${data.error.message}`);
            jsonRpcError.code = data.error.code;
            jsonRpcError.data = data.error.data; // Include any additional error data
            jsonRpcError.service = serviceName; // Add service context
            console.error(`${serviceName} JSON-RPC Error:`, jsonRpcError);
            throw jsonRpcError;
        }

        return data; // Return the full JSON-RPC response object

    } catch (error) {
        console.error(`Fetch error during call to ${serviceName}:`, error);
        // Re-throw the error with context and original error properties
        if (error.service) { // If it's an API error we already processed (HTTP or JSON-RPC)
             throw error;
        }
        // Otherwise, wrap a general fetch error
        // Include the response body text if available for debugging
        const fetchErr = new Error(`API call failed to ${serviceName}: ${error.message}${responseBodyText ? ` Body: ${responseBodyText.substring(0, 200)}...` : ''}`);
        fetchErr.originalError = error; // Keep original error for debugging
        throw fetchErr;
    }
}


// --- Flipside Crypto (V2 JSON-RPC) Workflow Functions ---

// Converts natural language question to SQL using Gemini API
// This function is updated to provide more specific guidance for Flipside SQL.
async function convertNLtoSQL(question) {
  const prompt = `
    You are an expert SQL writer specializing in blockchain data analysis, specifically for the Flipside Crypto data platform which uses Snowflake SQL.
    Your task is to convert the following natural language question into a concise and valid SQL query for Flipside.

    **Strict Guidelines for Flipside SQL Generation:**
    1.  **Output Format:** Output ONLY the raw SQL query. Do NOT include any explanations, comments, markdown formatting (like \`\`\`sql\`), or any other text before or after the query.
    2.  **Platform:** The target platform is **Flipside Crypto** and it uses **Snowflake SQL**.
    3.  **Table Names:** Use standard Flipside table names with their correct schema prefixes. **Default to the 'ethereum' chain prefix unless a different chain is explicitly mentioned in the question.** Prioritize these common tables and their likely schema paths:
        * \`ethereum.core.fact_transactions\` (for basic transaction data)
        * \`ethereum.core.fact_token_transfers\` (for token transfer events)
        * \`ethereum.erc20.tokens\` (for looking up token addresses by symbol)
        * \`ethereum.erc20.balances\` (for latest token balances per holder)
        * \`ethereum.prices.fact_hourly_token_prices\` (for token prices)
        * For other chains (e.g., Solana, Polygon), use the appropriate chain prefix (e.g., \`solana.core.fact_transactions\`, \`polygon.erc20.balances\`).
    4.  **Column Names:** Use standard Flipside column names like \`block_timestamp\`, \`block_time\`, \`tx_hash\`, \`from_address\`, \`to_address\`, \`contract_address\`, \`token_address\`, \`symbol\`, \`holder\`, \`balance\`, \`amount\`, \`price\`.
    5.  **Date/Time Filtering:** Use \`block_timestamp\` or \`block_time\` for time filtering. Employ Snowflake-compatible functions:
        * For "today": \`WHERE DATE(block_time) = CURRENT_DATE()\` or \`WHERE block_timestamp >= CURRENT_DATE()\`
        * For time ranges: \`WHERE block_timestamp >= CURRENT_DATE() - INTERVAL 'N day'\` or \`INTERVAL 'N month'\`
        * For hourly grouping: \`date_trunc('hour', block_timestamp)\`
    6.  **Token Address Lookup:** To filter by a token symbol, always use a subquery on the appropriate \`erc20.tokens\` table (e.g., \`ethereum.erc20.tokens\`) to get the \`token_address\`. Example: \`WHERE token_address = (SELECT token_address FROM ethereum.erc20.tokens WHERE symbol = 'TOKEN_SYMBOL')\`. Ensure the token symbol is in uppercase.
    7.  **Token Balances:** The appropriate \`erc20.balances\` table (e.g., \`ethereum.erc20.balances\`) provides the latest balance per \`holder\` for a given \`token_address\`. Filter by \`balance > 0\` to count actual holders.
    8.  **Counting:** Use \`COUNT(DISTINCT column_name)\` for unique counts (e.g., \`COUNT(DISTINCT tx_hash)\`, \`COUNT(DISTINCT from_address)\`, \`COUNT(DISTINCT to_address)\`, \`COUNT(DISTINCT holder)\`).
    9.  **Simplicity & Efficiency:** Generate the simplest possible query that answers the question using the available tables and columns. Avoid unnecessary complexity.
    10. **Error Handling:** If the question is too complex, ambiguous, or cannot be answered with a single, standard Flipside SQL query using the specified tables and patterns, output: "ERROR: Cannot formulate query".

    Analyze the following natural language question and generate the corresponding Flipside Snowflake SQL query:

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

  if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
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

// Submits the SQL query to Flipside V2 JSON-RPC for execution
async function submitFlipsideQuery(sqlQuery) {
    // Hardcoding required parameters for createQueryRun based on user's working example (Step 1).
    // NOTE: Hardcoding sensitive or environment-specific values is NOT recommended
    // for production applications. Environment variables are preferred.
    const hardcodedDataSource = "snowflake-default"; // Using value from user's Step 1
    const hardcodedDataProvider = "flipside"; // Using value from user's Step 1

    const jsonRpcPayload = {
        "jsonrpc": "2.0",
        "method": "createQueryRun", // JSON-RPC method to create a query run
        "params": [
            {
                "sql": sqlQuery,
                // Add required parameters, hardcoded based on user's example
                "maxAgeMinutes": 0, // Using value from user's Step 1
                "resultTTLHours": 1, // Including from user's Step 1
                "tags": { // Including from user's Step 1
                    "source": "chainsage-proxy", // Changed source tag
                    "env": "netlify" // Changed env tag
                },
                "dataSource": hardcodedDataSource,
                "dataProvider": hardcodedDataProvider
            }
        ],
        "id": 1 // Request ID
    };

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': FLIPSIDE_API_KEY // API Key in header for V2
        },
        body: JSON.stringify(jsonRpcPayload),
    };

    // Use the V2 JSON-RPC endpoint
    const data = await fetchApi(FLIPSIDE_API_ENDPOINT, options, 'Flipside (Submit Query)');

    // --- Debugging Logs ---
    console.log("Debug: Full response from Flipside submit:", JSON.stringify(data, null, 2));
    console.log("Debug: data?.result:", data?.result);
    console.log("Debug: data?.result?.queryRun:", data?.result?.queryRun);
    console.log("Debug: data?.result?.queryRun?.queryRunId:", data?.result?.queryRun?.queryRunId);
    // --- End Debugging Logs ---

    let queryRunId;
    try {
        // Explicitly try to access the nested property
        queryRunId = data.result.queryRun.queryRunId;
        console.log("Debug: Successfully accessed queryRunId:", queryRunId);
    } catch (accessError) {
        console.error("Debug: Error accessing queryRunId:", accessError);
        console.error("Flipside submit response did not contain expected queryRunId structure:", data);
        throw new Error(`Failed to submit query to Flipside: Could not extract queryRunId from response. Details: ${accessError.message}`);
    }

    // Check if the extracted queryRunId is a non-empty string
    if (typeof queryRunId === 'string' && queryRunId.length > 0) {
        console.log("Flipside Query Submitted, Query Run ID:", queryRunId);
        return queryRunId;
    } else {
         console.error("Flipside submit response contained invalid or empty queryRunId:", data);
         throw new Error("Failed to submit query to Flipside: Invalid or empty queryRunId received.");
    }
}

// Gets the status of a Flipside V2 JSON-RPC query execution
async function getFlipsideQueryStatus(queryRunId) {
    const jsonRpcPayload = {
        "jsonrpc": "2.0",
        "method": "getQueryRun", // JSON-RPC method to get query run status
        "params": [
            {
                "queryRunId": queryRunId
            }
        ],
        "id": 1 // Request ID
    };

    const options = {
        method: 'POST', // JSON-RPC calls are typically POST
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': FLIPSIDE_API_KEY // API Key in header for V2
        },
        body: JSON.stringify(jsonRpcPayload),
    };

    // Use the V2 JSON-RPC endpoint
    const data = await fetchApi(FLIPSIDE_API_ENDPOINT, options, 'Flipside (Get Status)');

    // Flipside V2 returns status in data.result.status
    // Using optional chaining for a more resilient check
    if (!data?.result?.status) {
        console.error("Invalid response from Flipside status check:", data);
        throw new Error("Failed to get query status from Flipside: Invalid response structure.");
    }

    return data.result.status; // e.g., 'RUNNING', 'COMPLETED', 'FAILED' (Note V2 status values might be uppercase)
}


// Waits for a Flipside V2 JSON-RPC query execution to complete, with timeout
async function waitForFlipsideExecution(queryRunId) {
  const startTime = Date.now();
  console.log(`Waiting for Flipside execution ${queryRunId} to complete...`);

  while (true) {
    // Check for timeout
    if (Date.now() - startTime > FLIPSIDE_EXECUTION_MAX_WAIT_TIME) {
      console.error(`Flipside query execution ${queryRunId} timed out.`);
      throw new Error(`Flipside query execution timed out after ${FLIPSIDE_EXECUTION_MAX_WAIT_TIME / 1000} seconds.`);
    }

    try {
      const status = await getFlipsideQueryStatus(queryRunId);
      console.log(`Flipside Execution ${queryRunId} status: ${status}`); // Log status for debugging

      switch (status) {
        case 'COMPLETED': // Flipside V2 status for completion
          console.log(`Flipside Execution ${queryRunId} completed successfully.`);
          return true; // Success
        case 'FAILED': // Flipside V2 status for failure
          console.error(`Flipside Execution ${queryRunId} failed.`);
          // You might want to fetch results here to get error details if available
          throw new Error(`Flipside query execution failed.`); // Terminal state
        case 'CANCELLED': // Handle cancelled state as well
            console.error(`Flipside Execution ${queryRunId} was cancelled.`);
            throw new Error(`Flipside query execution was cancelled.`);
        case 'RUNNING': // Flipside V2 status for in progress
        case 'PENDING': // Flipside V2 status for queued
        case 'CANCELLING': // Flipside V2 status for cancelling
          // Continue polling
          break; // Explicitly break the switch to continue the loop
        default:
          console.warn(`Unknown Flipside execution status encountered for ${queryRunId}: ${status}`);
          // Decide how to handle unknown states.
          throw new Error(`Encountered unknown Flipside execution status: ${status}`); // Treat as fatal for now
      }
    } catch (error) {
       console.error(`Error during polling for Flipside execution ${queryRunId}:`, error);
       // If getFlipsideQueryStatus throws, re-throw to break the wait loop
       throw new Error(`Polling error for Flipside execution ${queryRunId}: ${error.message}`);
    }

    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, FLIPSIDE_EXECUTION_POLL_INTERVAL));
  }
}


// Gets the results of a completed Flipside V2 JSON-RPC query execution
async function getFlipsideQueryResults(queryRunId) {
    // Note: Flipside V2 results might require pagination if the result set is large.
    // This implementation fetches the first page. For large results, you'd need
    // to iterate through pages using the 'page' parameter in the JSON-RPC payload.
    const jsonRpcPayload = {
        "jsonrpc": "2.0",
        "method": "getQueryRunResults", // JSON-RPC method to get results
        "params": [
            {
                "queryRunId": queryRunId,
                "format": "json", // Request JSON format for easier processing
                "page": {
                    "number": 1, // Fetch the first page
                    "size": FLIPSIDE_RESULTS_PAGE_SIZE // Use defined page size
                }
            }
        ],
        "id": 1 // Request ID
    };

   const options = {
        method: 'POST', // JSON-RPC calls are typically POST
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': FLIPSIDE_API_KEY // API Key in header for V2
        },
        body: JSON.stringify(jsonRpcPayload),
    };

    // Use the V2 JSON-RPC endpoint
    const data = await fetchApi(FLIPSIDE_API_ENDPOINT, options, 'Flipside (Get Results)');

    // Flipside V2 returns results in data.result.rows and columnNames
    // Using optional chaining for a more resilient check
    if (!data?.result?.rows) {
        console.warn("Flipside response did not contain expected 'result' or 'rows' property:", data);
        return { columnNames: [], rows: [] }; // Return empty structure if no results found
    }

    // Flipside V2 results structure includes columnNames at data.result.columnNames
    // Using optional chaining for a more resilient check
    if (!data?.result?.columnNames) {
        console.warn("Flipside response did not contain expected 'columnNames' property:", data);
        // Attempt to infer column names from the first row if available
        if (data.result.rows.length > 0) {
            console.warn("Attempting to infer column names from the first row.");
             return {
                columnNames: Object.keys(data.result.rows[0]), // Infer column names from keys of the first row object
                rows: data.result.rows
            };
        } else {
             return { columnNames: [], rows: [] }; // No data, no column names
        }
    }


    console.log(`Successfully fetched ${data.result.rows.length} rows from Flipside.`);
    // Return an object containing both column names and rows for better context for summarization
    return {
        columnNames: data.result.columnNames,
        rows: data.result.rows
    };
}


// Summarizes the Flipside data using Gemini API
async function summarizeFlipsideData(flipsideData, originalQuestion) {
    // Prepare data for Gemini, including column names and rows
  let dataToSend = flipsideData;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(flipsideData);

  // Simple sampling if data is too large for the prompt
  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    // Sample the rows, keep column names
    if (Array.isArray(flipsideData.rows)) {
         dataToSend = {
             columnNames: flipsideData.columnNames,
             rows: flipsideData.rows.slice(0, Math.min(flipsideData.rows.length, 50))
         };
    } else {
         dataToSend = jsonData.substring(0, MAX_DATA_LENGTH) + "..."; // Fallback for non-array data
    }
  }

   if (!dataToSend || (Array.isArray(dataToSend.rows) && dataToSend.rows.length === 0)) {
      return "The query ran successfully on Flipside but returned no data.";
  }


  const prompt = `
    You are an insightful data analyst specializing in blockchain data.
    A user asked the following question: "${originalQuestion}"
    Data was retrieved from a Flipside Crypto query execution. Here is the relevant data (potentially sampled if large), including column names and rows:
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

  if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
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
    let queryRunId = null; // Renamed from queryId to match V2 terminology
    let flipsideData = null;
    let finalInsight = "An unexpected error occurred."; // Default error message
    let statusCode = 500; // Default status code for errors

    try {
        // 1. Convert NL to SQL using Gemini
        sqlQuery = await convertNLtoSQL(question);
        console.log("Step 1: NL to SQL completed.");

        // 2. Submit the SQL query to Flipside V2 JSON-RPC
        queryRunId = await submitFlipsideQuery(sqlQuery);
        console.log("Step 2: Flipside Query Submitted.");

        // 3. Wait for Flipside execution to complete
        await waitForFlipsideExecution(queryRunId);
        console.log("Step 3: Flipside Execution Completed.");

        // 4. Get the results from Flipside V2 JSON-RPC
        flipsideData = await getFlipsideQueryResults(queryRunId);
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
            // queryRunId: queryRunId,
            // rawFlipsideData: flipsideData // Be cautious with large data
        }),
    };
};
