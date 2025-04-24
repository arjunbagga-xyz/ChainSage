// This frontend code calls a backend proxy (Netlify Function)
// that uses Gemini and Covalent Goldrush APIs securely.
// API keys are NOT stored or used directly in this file.

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
    // Use innerHTML to render markdown for code blocks if needed (though less likely with Covalent summary)
    wizardMsg.innerHTML = `ChainSage: ${formatWizardText(wizardText)}`;
    chatLog.appendChild(wizardMsg);
  }

  // Auto-scroll to the latest message
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Helper function to format wizard text (less critical now, but good practice)
function formatWizardText(text) {
    // Simple markdown code block formatting (might not be used by the new backend)
    let formattedText = text.replace(/```sql\s*([\s\S]*?)```/g, (match, code) => {
        return `<pre><code class="language-sql">${code.trim()}</code></pre>`;
    });
     formattedText = formattedText.replace(/```json\s*([\s\S]*?)```/g, (match, code) => {
        return `<pre><code class="language-json">${code.trim()}</code></pre>`;
    });
    // Add other formatting if needed (e.g., bold, italics)
    return formattedText;
}


// --- Main Application Logic (Calls the Backend Proxy) ---
async function askWizard(question) {
  // Don't process empty questions
  if (!question || question.trim() === '') return;

  // Clear previous error messages if any
  const chatLog = document.getElementById('chat-log');
  const errorMessages = chatLog.querySelectorAll('.chat-message.error-message');
  errorMessages.forEach(msg => msg.remove());


  // Display the user's question
  appendChat(question, null);
  // Display an initial message indicating processing is starting
  appendChat(null, 'Casting spell... (Consulting the Covalent Oracle)');

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
      // If the function returned an error status (e.g., 400, 500), parse the error message from its body
      const errorData = await response.json();
      console.error('Error response from proxy function:', errorData);
      // Display the error message from the function
      appendChat(null, `An error occurred while consulting the Oracle: ${errorData.error || `Proxy function returned error status: ${response.status}`}`);
      return; // Stop processing on non-OK response
    }

    // Parse the successful response from the function
    const result = await response.json();
    console.log('Successful response from proxy function:', result);

    // The backend is designed to return the final insight in the 'insight' property
    if (result.insight) {
        appendChat(null, result.insight);
    } else {
        // Handle unexpected response format from the backend
        console.error('Received unexpected response format from proxy function:', result);
        appendChat(null, 'Received an unexpected response format from the Oracle.');
    }


  } catch (error) {
    // Handle any errors that occurred during the fetch itself (e.g., network issues)
    console.error('Error calling proxy function:', error);
    // Display a user-friendly error message
    appendChat(null, `A network error occurred while trying to reach the Oracle: ${error.message}`);
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
