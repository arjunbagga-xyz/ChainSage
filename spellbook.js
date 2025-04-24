
const GEMINI_API_KEY = os.getenv("GEMINI_API")
const DUNE_API_KEY = os.getenv("DUNE_API")
const GEMINI_MODEL = 'gemini-2.0-flash'; 
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const DUNE_API_URL = 'https://api.dune.com/api/v1';

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

const EXECUTION_POLL_INTERVAL = 5000; 
const EXECUTION_MAX_WAIT_TIME = 30000; 


// --- UI Functions ---
function appendChat(userText, wizardText) {
  const chatLog = document.getElementById('chat-log');

  if (userText) {
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-message user-message';
    userMsg.textContent = `You: ${userText}`;
    chatLog.appendChild(userMsg);
  }

  if (wizardText) {
    const wizardMsg = document.createElement('div');
    wizardMsg.className = 'chat-message wizard-message';
    wizardMsg.textContent = `ChainSage: ${wizardText}`;
    chatLog.appendChild(wizardMsg);
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- API Interaction Functions ---

// Improved error handling function
async function handleApiResponse(response, serviceName) {
  if (!response.ok) {
    let errorBody = 'Could not parse error response.';
    try {
      errorBody = await response.json();
    } catch (e) {
    }
    console.error(`${serviceName} Error Response:`, errorBody);
    const errorMessage = `Error ${response.status} from ${serviceName}: ${errorBody.error?.message || response.statusText || 'Unknown error'}`;
    throw new Error(errorMessage);
  }
  return response.json();
}

// Convert natural language question to SQL query using Gemini API
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

  try {
    console.log("Sending request to Gemini for SQL generation...");
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // --- Apply specific generation config for SQL ---
        generationConfig: SQL_GENERATION_CONFIG
      }),
    });

    const data = await handleApiResponse(response, 'Gemini (SQL Generation)');

    // --- More Robust Response Parsing ---
    if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
      console.error("Invalid response structure from Gemini:", data);
      throw new Error('Received invalid response structure from Gemini.');
    }

    let sqlQuery = data.candidates[0].content.parts[0].text.trim();

    // Remove potential markdown code blocks if the model adds them despite instructions
    sqlQuery = sqlQuery.replace(/^```sql\s*/i, '').replace(/```$/, '').trim();

    if (sqlQuery.startsWith("ERROR:") || sqlQuery.length < 10) { // Basic check for errors or trivial responses
        throw new Error(`Gemini indicated an issue or returned a non-query response: ${sqlQuery}`);
    }

    console.log("Generated SQL:", sqlQuery);
    // --- Placeholder for SQL Validation ---
    // In a real automated system, you'd want some form of validation here.
    // Client-side validation is complex. Server-side might use a SQL parser.
    // For now, we rely on Dune API errors.
    // validateSQL(sqlQuery);

    return sqlQuery;

  } catch (error) {
    console.error('Error in NL to SQL conversion:', error);
    // Propagate the specific error message
    throw new Error(`Failed to convert question to SQL: ${error.message}`);
  }
}

// Create a new query on Dune Analytics
async function createDuneQuery(sqlQuery, question) {
  try {
    console.log("Creating Dune query...");
    const response = await fetch(`${DUNE_API_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DUNE-API-KEY': DUNE_API_KEY,
      },
      body: JSON.stringify({
        name: `ChainSage Query - ${new Date().toISOString()}`, // More dynamic name
        description: `Generated by ChainSage for question: ${question}`, // Include original question
        query_sql: sqlQuery,
        is_private: true, // Keep generated queries private
      }),
    });
    const data = await handleApiResponse(response, 'Dune (Create Query)');
    console.log("Dune Query Created, ID:", data.query_id);
    return data.query_id;
  } catch (error) {
    console.error('Error creating Dune query:', error);
    throw new Error(`Failed to create Dune query: ${error.message}`);
  }
}

// Execute a query on Dune Analytics
async function executeDuneQuery(queryId) {
  try {
    console.log(`Executing Dune query ${queryId}...`);
    const response = await fetch(`${DUNE_API_URL}/query/${queryId}/execute`, {
      method: 'POST',
      headers: {
        // --- Correct Dune API Header ---
        'X-DUNE-API-KEY': DUNE_API_KEY,
        'Content-Type': 'application/json', // Good practice to include
      },
      // Optional: Add performance tier if needed: body: JSON.stringify({ performance: 'medium' })
    });
    const data = await handleApiResponse(response, 'Dune (Execute Query)');
    console.log("Dune Query Execution Started, Execution ID:", data.execution_id);
    return data.execution_id;
  } catch (error) {
    console.error('Error executing Dune query:', error);
    throw new Error(`Failed to execute Dune query: ${error.message}`);
  }
}

// Get the status of an execution on Dune Analytics
async function getExecutionStatus(executionId) {
  try {
    // No console log here to avoid flooding during polling
    const response = await fetch(`${DUNE_API_URL}/execution/${executionId}/status`, {
      method: 'GET',
      headers: {
        // --- Correct Dune API Header ---
        'X-DUNE-API-KEY': DUNE_API_KEY,
      },
    });
    // Don't use handleApiResponse here as failed status is expected during polling
    if (!response.ok) {
       // Handle specific errors like 404 Not Found differently if needed
       console.error(`Error fetching status for ${executionId}: ${response.status} ${response.statusText}`);
       // Decide if this error is terminal or retryable
       throw new Error(`Failed to get execution status (${response.status})`);
    }
    const data = await response.json();
    // console.log(`Execution ${executionId} status: ${data.state}`); // Optional debug log
    return data.state;
  } catch (error) {
    console.error('Error getting execution status:', error);
    // Propagate error for waitForExecution loop to handle
    throw error;
  }
}

// Wait for an execution to complete, with timeout
async function waitForExecution(executionId) {
  const startTime = Date.now();
  console.log(`Waiting for execution ${executionId} to complete...`);

  while (true) {
    // Check for timeout
    if (Date.now() - startTime > EXECUTION_MAX_WAIT_TIME) {
      throw new Error(`Query execution timed out after ${EXECUTION_MAX_WAIT_TIME / 1000} seconds.`);
    }

    try {
      const state = await getExecutionStatus(executionId);

      switch (state) {
        case 'QUERY_STATE_COMPLETED':
          console.log(`Execution ${executionId} completed.`);
          return true;
        case 'QUERY_STATE_FAILED':
        case 'QUERY_STATE_CANCELLED':
          console.error(`Execution ${executionId} failed or was cancelled (State: ${state}).`);
          // Optional: Try to get error details from results endpoint if state is FAILED
          throw new Error(`Query execution ${state.toLowerCase().replace('query_state_', '')}.`);
        case 'QUERY_STATE_EXECUTING':
        case 'QUERY_STATE_PENDING':
          // Continue polling
          break; // Explicitly break the switch
        default:
          console.warn(`Unknown execution state encountered: ${state}`);
          // Treat unknown states cautiously, maybe throw error after N attempts
          throw new Error(`Encountered unknown execution state: ${state}`);
      }
    } catch (error) {
       console.error(`Error polling execution status for ${executionId}:`, error);
       // Decide if the polling error is fatal or if you want to retry
       // For simplicity, we'll throw here, but retry logic could be added
       throw new Error(`Failed to poll execution status: ${error.message}`);
    }

    // Wait before the next poll
    await new Promise(resolve => setTimeout(resolve, EXECUTION_POLL_INTERVAL));
  }
}


// Get the results of an execution on Dune Analytics
async function getExecutionResults(executionId) {
  try {
    console.log(`Fetching results for execution ${executionId}...`);
    const response = await fetch(`${DUNE_API_URL}/execution/${executionId}/results`, {
      method: 'GET',
      headers: {
        // --- Correct Dune API Header ---
        'X-DUNE-API-KEY': DUNE_API_KEY,
      },
      // Optional: Add limit/offset for pagination if needed
      // query parameters: ?limit=100&offset=0
    });
    const data = await handleApiResponse(response, 'Dune (Get Results)');

    if (data.result && data.result.rows) {
        console.log(`Successfully fetched ${data.result.rows.length} rows.`);
        return data.result.rows;
    } else {
        // Handle cases where execution might have completed but results are empty/unexpected format
        console.warn(`Execution results format unexpected for ${executionId}:`, data);
        return []; // Return empty array if no rows found
    }
  } catch (error) {
    console.error('Error getting execution results:', error);
    // Attempt to extract Dune error details if possible
    const duneError = error.message.includes("Dune") ? error.message : `Failed to get execution results: ${error.message}`;
    throw new Error(duneError);
  }
}

// Summarize data using Gemini API
async function summarizeData(data, originalQuestion) {
  // --- Handle Large Data Payloads ---
  let dataToSend = data;
  const MAX_DATA_LENGTH = 5000; // Adjust based on typical data size and token limits
  const jsonData = JSON.stringify(data);

  if (jsonData.length > MAX_DATA_LENGTH) {
    console.warn(`Data size (${jsonData.length}) exceeds limit (${MAX_DATA_LENGTH}). Summarizing sampled data.`);
    // Simple sampling: take first N rows. More sophisticated sampling could be used.
    dataToSend = data.slice(0, Math.min(data.length, 50)); // Example: summarize first 50 rows
  }

  if (dataToSend.length === 0) {
      return "The query ran successfully but returned no data.";
  }

  // --- Enhanced Prompt Engineering for Summarization ---
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

  try {
    console.log("Sending request to Gemini for summarization...");
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // --- Apply specific generation config for summarization ---
        generationConfig: SUMMARIZATION_CONFIG
      }),
    });

    const result = await handleApiResponse(response, 'Gemini (Summarization)');

     // --- More Robust Response Parsing ---
    if (!result.candidates || result.candidates.length === 0 || !result.candidates[0].content || !result.candidates[0].content.parts || result.candidates[0].content.parts.length === 0) {
      console.error("Invalid response structure from Gemini (Summarization):", result);
      throw new Error('Received invalid response structure from Gemini during summarization.');
    }

    const insight = result.candidates[0].content.parts[0].text.trim();
    console.log("Generated Insight:", insight);
    return insight;

  } catch (error) {
    console.error('Error summarizing data:', error);
    // Provide a user-friendly error message
    return `Unable to generate insights at this time. Error: ${error.message}`;
  }
}

// --- Main Application Logic ---
async function askWizard(question) {
  if (!question || question.trim() === '') return;

  appendChat(question, null); // Show user question immediately
  appendChat(null, 'Casting spell... (Generating SQL)'); // Initial wizard response

  let sqlQuery = null;
  let queryId = null;
  let executionId = null;
  let results = null;

  try {
    // 1. Convert NL to SQL
    sqlQuery = await convertNLtoSQL(question);
    appendChat(null, `Generated SQL (for debugging):\n\`\`\`sql\n${sqlQuery}\n\`\`\``); // Show SQL for debugging
    appendChat(null, 'Conjuring query on Dune...');

    // 2. Create Dune Query
    queryId = await createDuneQuery(sqlQuery, question);
    appendChat(null, `Query created (ID: ${queryId}). Executing...`);

    // 3. Execute Dune Query
    executionId = await executeDuneQuery(queryId);
    appendChat(null, `Execution started (ID: ${executionId}). Waiting for results... (this may take a moment)`);

    // 4. Wait for Completion
    await waitForExecution(executionId);
    appendChat(null, 'Query executed successfully. Fetching results...');

    // 5. Get Results
    results = await getExecutionResults(executionId);
    appendChat(null, `Retrieved ${results.length} rows. Generating insights...`);
    // Optional: Display raw results for debugging
    // appendChat(null, `Raw Results:\n\`\`\`json\n${JSON.stringify(results.slice(0, 5), null, 2)}\n...\n\`\`\``);


    // 6. Summarize Results
    const insight = await summarizeData(results, question);
    appendChat(null, insight); // Display final insight

  } catch (error) {
    console.error('Error processing question in askWizard pipeline:', error);
    // Provide more specific feedback based on where the error occurred
    let userErrorMessage = `An error occurred: ${error.message}`;
    if (error.message.includes("convert question to SQL")) {
        userErrorMessage = `The spell fizzled! Failed to generate SQL. ${error.message}`;
    } else if (error.message.includes("create Dune query")) {
        userErrorMessage = `The blockchain resisted! Failed to create query. ${error.message}`;
    } else if (error.message.includes("execute Dune query")) {
        userErrorMessage = `The blockchain resisted! Failed to execute query. ${error.message}`;
    } else if (error.message.includes("Query execution timed out")) {
        userErrorMessage = `The query took too long to execute. ${error.message}`;
    } else if (error.message.includes("Query execution failed") || error.message.includes("Query execution cancelled")) {
        userErrorMessage = `The query failed or was cancelled on Dune. ${error.message}`;
    } else if (error.message.includes("get execution results")) {
        userErrorMessage = `The blockchain resisted! Failed to fetch results. ${error.message}`;
    } else if (error.message.includes("summarizing data")) {
        userErrorMessage = `Could not summarize the results. ${error.message}`;
    }
     appendChat(null, userErrorMessage);
  }
}

// --- Event Listener ---
function handleEnter(event) {
  if (event.key === 'Enter' && !event.shiftKey) { // Allow Shift+Enter for newlines
    event.preventDefault(); // Prevent default Enter behavior (newline)
    const input = document.getElementById('question');
    const question = input.value;
    if (question.trim()) {
      askWizard(question);
      input.value = ''; // Clear input after sending
    }
  }
}

// --- Initialization ---
// Ensure the DOM is loaded before attaching the event listener
document.addEventListener('DOMContentLoaded', (event) => {
    const questionInput = document.getElementById('question');
    if (questionInput) {
        questionInput.addEventListener('keydown', handleEnter);
        console.log("ChainSage Ready!");
    } else {
        console.error("Could not find question input element.");
    }
});
