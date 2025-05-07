// This frontend code calls a backend proxy (Netlify Function)
// that uses the Modula API.
// API keys are NOT stored or used directly in this file.

// The URL for your Netlify Function endpoint.
const PROXY_FUNCTION_URL = '/.netlify/functions/chainsage-proxy';

// --- Chat History Storage ---
// Initialize an empty array to store the conversation history.
// Each element will be an object like { role: 'user' | 'model', content: 'message text' }
let chatHistory = [];

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
        // Using innerHTML allows for potential future formatting (e.g., markdown)
        wizardMsg.innerHTML = `ChainSage: ${formatWizardText(wizardText)}`;
        chatLog.appendChild(wizardMsg);
    }

    // Auto-scroll to the latest message
    chatLog.scrollTop = chatLog.scrollHeight;
}

// Helper function to format wizard text. This version assumes plain text from Modula.
// You might enhance this later to handle markdown or other formatting if your LLM provides it.
function formatWizardText(text) {
    return text; // No special formatting for now.
}


// --- Main Application Logic (Calls the Backend Proxy) ---
async function askWizard(question) {
    // Don't process empty questions
    if (!question || question.trim() === '') return;

    // Clear previous error messages if any
    const chatLog = document.getElementById('chat-log');
    const errorMessages = chatLog.querySelectorAll('.chat-message.error-message');
    errorMessages.forEach(msg => msg.remove());

    // 1. Add the user's question to the chat history and display it
    const userMessage = { role: 'user', content: question };
    chatHistory.push(userMessage);
    appendChat(question, null); // Display the user's message

    // Display an initial message indicating processing is starting.
    // This message itself is NOT added to the chatHistory, as it's a UI indicator.
    appendChat(null, 'Casting spell...');

    try {
        console.log(`Sending chat history to backend proxy. Latest question: "${question}"`);
        console.log("Current chat history:", chatHistory); // Log the history being sent

        // 2. Make the fetch request to your Netlify Function endpoint
        // Send the entire chatHistory array in the request body
        const response = await fetch(PROXY_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            // Send the history array under the key 'history'
            body: JSON.stringify({ history: chatHistory }),
        });

        // Check if the response from the function was successful
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error response from proxy function:', errorData);
            const errorMessage = errorData.error || `Proxy function returned error status: ${response.status}`;
            appendChat(null, `An error occurred while consulting the Oracle: ${errorMessage}`);

            // Optional: Add the error message to history with a special role or handle separately
            // For simplicity, we won't add errors to the main chatHistory array for LLM context.
            return; // Stop processing on error
        }

        // Parse the successful response
        const result = await response.json();
        console.log('Successful response from proxy function:', result);

        // The backend returns the insight.
        if (result.insight) {
            // 3. Add the wizard's response to the chat history and display it
            const wizardMessage = { role: 'model', content: result.insight };
            chatHistory.push(wizardMessage);
            appendChat(null, result.insight); // Display the wizard's message
        } else {
            console.error('Received unexpected response format:', result);
            appendChat(null, 'Received an unexpected response format from the Oracle.');
            // Handle unexpected format in history? Probably not necessary.
        }

    } catch (error) {
        console.error('Error calling proxy function:', error);
        appendChat(null, `A network error occurred while trying to reach the Oracle: ${error.message}`);
        // Handle network errors in history? Probably not necessary.
    } finally {
        // Remove the "Casting spell..." message after the response is received or on error
        const castingMessage = chatLog.querySelector('.chat-message.wizard-message:last-child');
        if (castingMessage && castingMessage.innerHTML.includes('Casting spell...')) {
             castingMessage.remove();
        }
    }
}

// --- Event Listener ---
function handleEnter(event) {
    // Check if Enter was pressed without the Shift key
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); // Prevent default form submission or newline
        const input = document.getElementById('question');
        const question = input.value;
        if (question.trim()) { // Only send if the input is not empty or just whitespace
            askWizard(question);
            input.value = ''; // Clear the input field after sending
        }
    }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', (event) => {
    const questionInput = document.getElementById('question');
    if (questionInput) {
        // Add the event listener for the Enter key
        questionInput.addEventListener('keydown', handleEnter);
        console.log("ChainSage Frontend Ready! (Waiting for user input)");
        // Optional: Display an initial welcome message from the wizard
        // appendChat(null, "Greetings, mortal! Ask me about the blockchain.");
    } else {
        console.error("Could not find question input element with ID 'question'. Ensure your HTML has an input with id='question'.");
    }
});
