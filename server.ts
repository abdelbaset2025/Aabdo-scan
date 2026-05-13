import express from 'express';
import path from 'path';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use memory storage for multer as we'll just send bits to Gemini
  const upload = multer({ storage: multer.memoryStorage() });

  // Helper to get Gemini model lazily with fresh env vars
  const getAiModel = () => {
    const key = (process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
    if (!key) {
      console.error('[Gemini] API Key is MISSING');
      throw new Error("GEMINI_API_KEY_MISSING");
    }
    const maskedKey = key.substring(0, 6) + '...' + key.substring(key.length - 4);
    console.log(`[Gemini] Using API Key: ${maskedKey} (Length: ${key.length})`);
    
    const genAI = new GoogleGenAI({ apiKey: key });
    return genAI.models;
  };

  // Telegram Bot Setup
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (TELEGRAM_TOKEN && TELEGRAM_TOKEN.length > 10) {
    try {
      const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
      console.log('--- Telegram Bot Initialized ---');
      
      bot.on('error', (error) => console.error('Telegram Bot Error:', error));
      bot.on('polling_error', (error) => console.error('Polling Error:', error));

      // Handle /start command
      bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "أهلاً بك في *AI DocScanner*! 🤖\n\nأرسل لي صورة لأي إيصال، بطاقة عمل، أو مستند وسأقوم بتحليله فوراً.\n\nيمكنك أيضاً التحدث معي في أي وقت وسأجيبك باستخدام الذكاء الاصطناعي.", { parse_mode: 'Markdown' });
      });

      bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        console.log(`[Telegram Bot] Photo received from chatId: ${chatId}`);
        const fileId = msg.photo?.[msg.photo.length - 1].file_id;
        if (!fileId) return;
        try {
          bot.sendMessage(chatId, "جاري معالجة المستند... 🪄");
          
          const fileLink = await bot.getFileLink(fileId);
          console.log('[Telegram Bot] Processing image from:', fileLink);
          
          const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
          const base64 = Buffer.from(response.data).toString('base64');
          
          const prompt = `
            Identify and classify this document (receipt, business_card, id_card, or other).
            Extract key metadata into a clean JSON object. 
            Support Arabic and English text extraction.
          `;
          
          const model = getAiModel();
          const result = await model.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
              parts: [
                { text: prompt },
                { inlineData: { data: base64, mimeType: 'image/jpeg' } }
              ]
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  classification: { type: Type.STRING },
                  metadata: { type: Type.OBJECT },
                  confidence: { type: Type.NUMBER }
                },
                required: ["classification", "metadata"]
              }
            }
          });
          
          const resultText = result.text;
          console.log('[Telegram Bot] AI JSON Response:', resultText);
          
          if (!resultText) throw new Error("Empty response from AI");

          const data = JSON.parse(resultText);
          
          let responseMsg = `✅ *تم المسح بنجاح*\n\n`;
          const typeMap: Record<string, string> = {
            'receipt': 'إيصال / فاتورة',
            'business_card': 'بطاقة عمل',
            'id_card': 'بطاقة هوية',
            'other': 'مستند آخر'
          };
          
          responseMsg += `📄 *النوع:* ${typeMap[data.classification] || data.classification || 'غير معروف'}\n`;
          
          if (data.metadata && typeof data.metadata === 'object') {
            responseMsg += `\n*البيانات المستخرجة:*\n`;
            for (const [key, value] of Object.entries(data.metadata)) {
              if (value && String(value).trim()) {
                const label = key.replace(/_/g, ' ');
                responseMsg += `• *${label}:* ${value}\n`;
              }
            }
          }

          await bot.sendMessage(chatId, responseMsg, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, responseMsg.replace(/[*_`]/g, ''));
          });

        } catch (err: any) { 
          console.error('[Telegram Bot] Photo Handler Error:', err);
          let userMsg = `❌ واجهت مشكلة في تحليل الصورة.\n\nالتفاصيل: ${err.message || 'خطأ غير معروف'}`;
          
          // Check for API Key issues
          const errString = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
          if (errString.includes('API_KEY_INVALID') || errString.includes('API key not valid') || errString.includes('INVALID_ARGUMENT') || errString.includes('GEMINI_API_KEY_MISSING')) {
            userMsg = "❌ مفتاح API الخاص بـ Gemini غير صحيح أو مفقود. يرجى التحقق من الإعدادات > Secrets وإضافة GEMINI_API_KEY صحيح.";
          } else if (errString.includes('PERMISSION_DENIED')) {
            userMsg = "❌ تم رفض الوصول (Permission Denied). يرجى التأكد من أن مفتاح API لديه الصلاحيات اللازمة (Settings > Secrets).";
          } else if (err.response?.promptFeedback?.blockReason) {
             userMsg = `❌ تم حظر المحتوى لسبب: ${err.response.promptFeedback.blockReason}`;
          } else if (err.message?.includes('SAFETY')) {
            userMsg = "❌ تعذر تحليل الصورة بسبب سياسات الأمان. يرجى محاولة صورة أخرى.";
          } else if (err.message?.includes('quota')) {
            userMsg = "❌ تم تجاوز حد الاستخدام المسموح به. يرجى المحاولة لاحقاً.";
          }
          
          bot.sendMessage(chatId, userMsg); 
        }
      });

      bot.on('message', async (msg) => {
        if (msg.photo || !msg.text || msg.text.startsWith('/')) return;
        
        const chatId = msg.chat.id;
        try {
          const model = getAiModel();
          const result = await model.generateContent({
             model: 'gemini-3-flash-preview',
             contents: `أنت مساعد ذكي لتطبيق AI DocScanner. رد باللغة العربية على: ${msg.text}`
          });
          const replyText = result.text;
          
          if (!replyText) {
             throw new Error("AI returned empty text");
          }

          await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, replyText);
          });
        } catch (err: any) {
          console.error('[Telegram Bot] Chat Handler Error:', err);
          let errorText = `عذراً، واجهت مشكلة في معالجة طلبك حالياً.\n\nالتفاصيل: ${err.message || 'خطأ غير معروف'}`;
          
          const errString = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
          if (errString.includes('API_KEY_INVALID') || errString.includes('API key not valid') || errString.includes('INVALID_ARGUMENT') || errString.includes('GEMINI_API_KEY_MISSING')) {
            errorText = "❌ مفتاح API الخاص بـ Gemini غير صحيح أو مفقود. يرجى التحقق من الإعدادات > Secrets وإضافة GEMINI_API_KEY صحيح.";
          } else if (errString.includes('PERMISSION_DENIED')) {
            errorText = "❌ تم رفض الوصول (Permission Denied). يرجى التأكد من أن مفتاح API لديه الصلاحيات اللازمة (Settings > Secrets).";
          } else if (err.message?.includes('SAFETY')) {
            errorText = "عذراً، لا يمكنني الاستجابة لهذا النوع من الرسائل لسياسات الأمان.";
          } else if (err.response?.promptFeedback?.blockReason) {
            errorText = `عذراً، تم حظر الرد لسبب: ${err.response.promptFeedback.blockReason}`;
          }
          bot.sendMessage(chatId, errorText);
        }
      });
    } catch (e) { 
      console.error('Bot init error:', e); 
    }
  } else {
    console.log('Skipping Telegram Bot: TELEGRAM_BOT_TOKEN is missing.');
  }

  const isBotActive = Boolean(TELEGRAM_TOKEN && TELEGRAM_TOKEN.length > 10);

  // API Routes
  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); 

  app.get('/api/status', (req, res) => {
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.length > 5);
    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    res.json({ 
      telegramActive: hasTelegram,
      geminiActive: hasGemini,
      status: (hasTelegram && hasGemini) ? 'READY' : 'UNCONFIGURED'
    });
  });

  // Main Scan Route
  app.post('/api/scan', upload.single('document'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }

      const base64Image = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype;

      const model = getAiModel();
      // Part 1: The 'Ape-Level' Gemini Prompt
      // This prompt focuses on getting strictly JSON coordinates
      const prompt = `
        You are a highly precise document scanning and analysis assistant. 
        1. Identify the 4 main corners of the primary document in this image for perspective correction.
        2. Classify the document type (e.g., "receipt", "business_card", "id_card", "letter", "other").
        3. Extract key metadata based on the type:
           - For receipts: total_amount, currency, vendor_name, date.
           - For business_cards: person_name, company, email, phone.
           - For ID cards: document_number, expiry_date, name.
           - For others: a brief description.
        
        Output ONLY a JSON object. Use percentages (0-100) for coordinates.
        
        Response Format:
        {
          "corners": {
            "top_left": {"x": 12.5, "y": 15.2},
            "top_right": {"x": 88.1, "y": 14.8},
            "bottom_right": {"x": 92.3, "y": 85.1},
            "bottom_left": {"x": 10.2, "y": 84.7}
          },
          "classification": "receipt",
          "metadata": {
            "vendor": "Starbucks",
            "total": "15.50",
            "currency": "USD",
            "date": "2024-05-13"
          },
          "confidence": 0.98
        }
      `;

      const result = await model.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { data: base64Image, mimeType } },
            { text: prompt }
          ]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              corners: {
                type: Type.OBJECT,
                properties: {
                  top_left: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } },
                  top_right: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } },
                  bottom_right: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } },
                  bottom_left: { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } } }
                }
              },
              classification: { type: Type.STRING, enum: ["receipt", "business_card", "id_card", "letter", "other"] },
              metadata: { 
                type: Type.OBJECT,
                properties: {
                  vendor: { type: Type.STRING },
                  total: { type: Type.STRING },
                  currency: { type: Type.STRING },
                  date: { type: Type.STRING },
                  person_name: { type: Type.STRING },
                  company: { type: Type.STRING },
                  email: { type: Type.STRING },
                  phone: { type: Type.STRING },
                  document_number: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              },
              confidence: { type: Type.NUMBER }
            },
            required: ['corners', 'classification', 'metadata']
          }
        }
      });

      const scanData = JSON.parse(result.text);
      
      res.json({
        success: true,
        ...scanData,
        originalImage: `data:${mimeType};base64,${base64Image}`
      });

    } catch (error: any) {
      console.error('Scan Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Twilio Webhook Skeleton
  app.post('/api/webhook/twilio', async (req, res) => {
    // Twilio sends a POST request with 'MediaUrl0' if an image is sent
    const mediaUrl = req.body.MediaUrl0;
    const from = req.body.From;

    console.log(`Received WhatsApp message from ${from}. Media: ${mediaUrl}`);

    // In a real app:
    // 1. Download image from mediaUrl
    // 2. Run Gemini scan
    // 3. Run OpenCV crop
    // 4. Send back via Twilio WhatsApp API
    
    res.set('Content-Type', 'text/xml');
    res.send('<Response><Message>AI DocScanner is processing your image... (Simulated Response)</Message></Response>');
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
