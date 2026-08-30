// Vercel entry point. Vercel's Express detector requires a root-level index/app/server
// file containing a literal `express` import; the app itself is the default export.
// Static files come from public/ (Vercel's CDN); every other route hits the Express app.
import 'express';
import app from './server/dist/index.js';

export default app;
