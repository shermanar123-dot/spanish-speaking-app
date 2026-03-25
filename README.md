# Habla Diario - Spanish Speaking App

A full-stack web application designed for daily Spanish speaking practice, utilizing the Gemini API for personalized assessments, FSI-style drills, vocabulary generation, and roleplay scenarios.

## Features

*   **Personalized Assessment:** Evaluates your CEFR level through an interactive interview.
*   **FSI Drills:** Generates tailored substitution, transformation, response, and translation drills.
*   **Vocabulary Generation:** Creates high-frequency vocabulary lists with synonyms and antonyms.
*   **Roleplay:** Practice real-world scenarios with a conversational AI partner.
*   **Voice Integration:** Uses the browser's Web Speech API for voice input and output.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v16 or higher recommended)
*   A Google Gemini API Key

## Setup and Installation

1.  **Clone or navigate to the project directory:**
    \`\`\`powershell
    cd C:\\Users\\Joshua\\MyGeminiProject\\Spanish-speaking-app
    \`\`\`

2.  **Install dependencies:**
    \`\`\`powershell
    npm install
    \`\`\`

3.  **Environment Variables:**
    Create a \`.env\` file in the root directory (if one does not already exist) and add your Gemini API key:
    \`\`\`env
    GEMINI_API_KEY=your_actual_api_key_here
    PORT=3000
    # Optional Security Settings:
    # APP_USER=admin
    # APP_PASSWORD=secret
    \`\`\`

## How to Run Locally (Without Gemini CLI)

To run the application directly in PowerShell or any terminal:

1.  **Start the server:**
    \`\`\`powershell
    node server.js
    \`\`\`
    *Note: The terminal will stay active while the server is running. To stop the server, press \`Ctrl + C\`.*

2.  **Access the App:**
    Open your web browser and navigate to:
    [http://localhost:3000](http://localhost:3000)

### Development Tip: Auto-Restart
If you are modifying the code and want the server to automatically restart when you save a file, you can use \`nodemon\`:
\`\`\`powershell
npm install -g nodemon
nodemon server.js
\`\`\`
