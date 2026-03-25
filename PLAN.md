# Habla Diario - Full-Stack Upgrade Plan

## 1. Objective
Transform the existing static HTML prototype ("Habla Diario") into a full-stack web application. The new architecture will securely utilize the Gemini API for Spanish content generation, add browser-native voice capabilities for roleplay, and persist user progress using a real SQLite database. The app will be designed for deployment on Google Cloud (Option B).

## 2. Technology Stack
*   **Frontend:** Vanilla HTML, CSS, and JavaScript (responsive for mobile).
*   **Backend:** Node.js with Express.js.
*   **Database:** SQLite (file-based). For Google Cloud deployment, we can use a Compute Engine instance or Cloud Run with a mounted persistent volume to preserve the database file.
*   **AI Integration:** Google Gemini API (via `@google/genai` SDK).
*   **Voice Tech:** Browser Web Speech API (`SpeechRecognition` for input, `SpeechSynthesis` for output).
*   **Deployment:** Google Cloud Platform (GCP).

## 3. New Core Features

### 3.1. Personalized Assessment
*   **Initial Flow:** When a user first uses the app (or requests a re-assessment), they will go through a brief interactive voice/text assessment.
*   **Mechanism:** Gemini will ask a few progressive questions in Spanish. Based on the user's responses, Gemini will evaluate their CEFR level (A1, A2, B1, etc.), strengths, and areas for improvement.
*   **Personalization:** This assessment profile will be saved to the database and passed as context to Gemini when generating future Drills and Roleplays, ensuring the difficulty and focus are tailored to the user.

### 3.2. Expanded FSI Drills
The Foreign Service Institute (FSI) method relies on various drill patterns. We will expand the generator to support:
*   **Patterns:**
    *   *Substitution:* Replace a word in the base sentence with a cue.
    *   *Transformation:* Change the sentence (e.g., present to past, affirmative to negative, singular to plural).
    *   *Response:* Answer a question using a specific cue.
    *   *Translation:* Translate a targeted English phrase to Spanish.
*   **Tenses:** Expanded to include Present, Preterite (Past), Imperfect (Past continuous), Future, Conditional, Present Perfect, and Present Subjunctive.

## 4. Architecture & File Structure
```text
Spanish-speaking-app/
├── public/
│   ├── index.html        (Refactored UI with Assessment tab)
│   ├── style.css         (Extracted styles)
│   └── app.js            (Frontend logic: UI, Voice API, Fetch calls)
├── server.js             (Express server entry point)
├── database.js           (SQLite setup and queries)
├── prompt_templates.js   (System instructions for Gemini generation)
├── .env                  (Environment variables: GEMINI_API_KEY, PORT)
├── package.json          (Node dependencies)
└── PLAN.md               (This document)
```

## 5. Execution Steps
1.  **Project Initialization:** Set up Node.js, install packages (`express`, `sqlite3`, `@google/genai`, `dotenv`, `cors`).
2.  **Database & Schema:** Create `users`, `assessment_profiles`, `progress`, and `activity_logs` tables in SQLite.
3.  **Backend API:** Implement routes for:
    *   Assessment (`/api/assessment/start`, `/api/assessment/evaluate`)
    *   Drills (`/api/generate/drills` - now supporting multiple patterns/tenses and using user profile)
    *   Vocab & Roleplay
    *   Progress tracking
4.  **Frontend Refactor:** Split the HTML into `public/` files. Add the Assessment UI flow. Update the Drills UI to support the new patterns and tenses.
5.  **Voice Integration:** Implement robust Web Speech API handling for mobile and desktop.
6.  **Integration Testing:** Connect frontend to backend and test Gemini API prompts.
7.  **Deployment Prep:** Add a `Dockerfile` and instructions for deploying to Google Cloud (Compute Engine / Cloud Run).
