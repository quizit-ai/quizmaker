# Quiz Generator (Gemini)

> **Beta:** this app is for beta testing only. Features may change and some things may not work as expected.

Upload a PDF, DOCX or audio file → get a quiz in English or Roman Urdu → download as PDF or DOCX.

**Question types** (pick one under "Question type" before generating, and per question when using "+ Add Questions"):
- **MCQ – single select**: 4 options, one correct answer (radio buttons).
- **MCQ – multi select**: 4 options, 2–3 correct answers (checkboxes, "select all that apply"). A question counts as correct only if *exactly* the right set of options is chosen.
- **True / False**: a statement with True/False (Sahi/Ghalat in Roman Urdu).

## Setup
1. Install Node.js 18+ (https://nodejs.org)
2. Get a free API key at https://aistudio.google.com/apikey
3. In this folder:
   ```
   npm install
   cp .env.example .env      # Windows: copy .env.example .env
   ```
   Open `.env` and paste your key after `GEMINI_API_KEY=`
4. Run:
   ```
   npm start
   ```
5. Open http://localhost:3000 (landing page) and click "Quiz Maker"

## Notes
- PDFs and audio (mp3, wav, m4a, aac, ogg, flac, aiff) go straight to Gemini, so scanned PDFs and recordings work. Upload limit is 20 MB.
- DOCX text is extracted locally, then sent to Gemini.
- Change the model in `.env` with `GEMINI_MODEL` (default `gemini-2.5-flash`).
- Your key stays on your machine in `.env` — never commit it.

## Admin panel & Google Sheets
1. Set `ADMIN_PASSWORD` in `.env` and restart. Open http://localhost:3000/admin (any username, that password).
2. **One-time Google setup**
   - Go to https://console.cloud.google.com, create/select a project, and enable the **Google Sheets API**.
   - IAM & Admin → Service Accounts → create one → Keys → Add key → JSON. Download the file.
   - Create a Google Sheet, click **Share**, and add the service account's email (shown in the admin panel) as **Editor**.
3. In the admin panel: paste the JSON key and save, then enter the spreadsheet URL and the sheet (tab) name you want. **Connect** creates that tab if it doesn't exist and adds the header row.
4. After submitting a quiz, the participant presses **Save to Google Sheet**. One row is added per participant to the configured tab: Timestamp, Name, Email, Score, Question 1, Answer 1, Question 2, Answer 2, …

Credentials and settings are stored in the local `data/` folder (git-ignored). Run `npm install` again after updating (new dependency: googleapis).
