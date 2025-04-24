// This frontend code now calls a backend proxy (Netlify Function)
// to handle API calls securely. API keys are NOT stored or used
// directly in this file.

// The URL for your Netlify Function endpoint.
// Netlify automatically makes functions in netlify/functions available at /.netlify/functions/
const PROXY_FUNCTION_URL = '/.netlify/functions/chainsage-proxy';

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

  // Auto-scroll to the latest message
  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- Main Application Logic (Calls the Backend Proxy) ---
async function askWizard(question) {
  // Don't process empty questions
  if (!question || question.trim() === '') return;

  // Clear previous error messages if any
  const chatLog = document.getElementById('chat-log');
  // Find and remove elements with the specific class for error messages
  const errorMessages = chatLog.querySelectorAll('.chat-message.error-message');
  errorMessages.forEach(msg => msg.remove());


  // Display the user's question
  appendChat(question, null);
  // Display an initial message indicating processing is starting
  appendChat(null, 'Casting spell... (Consulting the Oracle)');

  try {
    console.log(`Sending question to backend proxy: "${question}"`);

    // Make the fetch request to your Netlify Function endpoint
    const response = await fetch(PROXY_FUNCTION_URL, {
      method: 'POST', // Functions are typically called with POST for data
      headers: {
        'Content-Type': 'application/json', // Indicate that the body is JSON
      },
      // Send the user's question in the request body as JSON
      body: JSON.stringify({ question: question }),
    });

    // Check if the response from the function was successful (status code 2xx)
    if (!response.ok) {
      // If the function returned an error status, parse the error message from its body
      const errorData = await response.json();
      console.error('Error response from proxy function:', errorData);
      // Throw an error with the message from the function
      throw new Error(errorData.error || `Proxy function returned error status: ${response.status}`);
    }

    // Parse the successful response from the function
    const result = await response.json();
    console.log('Successful response from proxy function:', result);

    // Display the final insight received from the function
    // The function returns the insight in the 'insight' property
    appendChat(null, result.insight);

  } catch (error) {
    // Handle any errors that occurred during the fetch or processing the response
    console.error('Error calling proxy function:', error);
    // Display a user-friendly error message
    appendChat(null, `An error occurred while consulting the Oracle: ${error.message}`);
  }
}

// --- Event Listener ---
function handleEnter(event) {
  // Check if Enter key was pressed, but not Shift+Enter
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault(); // Prevent default form submission or newline
    const input = document.getElementById('question');
    const question = input.value;
    // Only ask if the input is not empty
    if (question.trim()) {
      askWizard(question);
      input.value = ''; // Clear the input field after sending
    }
  }
}

// --- Initialization ---
// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener('DOMContentLoaded', (event) => {
    const questionInput = document.getElementById('question');
    if (questionInput) {
        // Attach the keydown event listener to the input field
        questionInput.addEventListener('keydown', handleEnter);
        console.log("ChainSage Frontend Ready! (Waiting for user input)");
    } else {
        // Log an error if the input element wasn't found (helpful for debugging HTML)
        console.error("Could not find question input element with ID 'question'.");
    }
});
