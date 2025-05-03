// This frontend code calls a backend proxy (Netlify Function)
// that uses the Modula API.
// API keys are NOT stored or used directly in this file.

// The URL for your Netlify Function endpoint.
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
        wizardMsg.innerHTML = `ChainSage: ${formatWizardText(wizardText)}`;
        chatLog.appendChild(wizardMsg);
    }

    // Auto-scroll to the latest message
    chatLog.scrollTop = chatLog.scrollHeight;
}

// Helper function to format wizard text.  This version assumes plain text from Modula.
function formatWizardText(text) {
    return text; //  No special formatting for now.  Plain text from Modula.
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
    // Display an initial message indicating processing is starting.  Updated for Modula.
    appendChat(null, 'Consulting the Mobula Oracle...');

    try {
        console.log(`Sending question to backend proxy: "${question}"`);

        // Make the fetch request to your Netlify Function endpoint
        const response = await fetch(PROXY_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ question: question }),
        });

        // Check if the response from the function was successful
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error response from proxy function:', errorData);
            appendChat(null, `An error occurred while consulting the Oracle: ${errorData.error || `Proxy function returned error status: ${response.status}`}`);
            return;
        }

        // Parse the successful response
        const result = await response.json();
        console.log('Successful response from proxy function:', result);

        // The backend returns the insight.
        if (result.insight) {
            appendChat(null, result.insight);
        } else {
            console.error('Received unexpected response format:', result);
            appendChat(null, 'Received an unexpected response format from the Oracle.');
        }

    } catch (error) {
        console.error('Error calling proxy function:', error);
        appendChat(null, `A network error occurred while trying to reach the Oracle: ${error.message}`);
    }
}

// --- Event Listener ---
function handleEnter(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const input = document.getElementById('question');
        const question = input.value;
        if (question.trim()) {
            askWizard(question);
            input.value = '';
        }
    }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', (event) => {
    const questionInput = document.getElementById('question');
    if (questionInput) {
        questionInput.addEventListener('keydown', handleEnter);
        console.log("ChainSage Frontend Ready! (Waiting for user input)");
    } else {
        console.error("Could not find question input element with ID 'question'.");
    }
});
