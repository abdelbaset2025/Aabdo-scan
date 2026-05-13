import express from 'express';
import path from 'path';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

// Simple in-memory store for the last scan per user
const userScans = new Map<number, any>();
const imageCache = new Map<string, { buffer: Buffer, mimeType: string }>();
let currentHost = 'scanner-app.com';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Use memory storage for multer as we'll just send bits to Gemini
  const upload = multer({ storage: multer.memoryStorage() });

  // Helper to get Gemini model lazily with fresh env vars
  const getAiModel = () => {
    const key = (process.env.GEMINIAPIKEY || process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();
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
      console.log('[Telegram Bot] Attempting to initialize...');
      const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
      
      bot.on('error', (error) => console.error('[Telegram Bot] Error:', error));
      bot.on('polling_error', (error) => {
        // Log 409 errors (conflict) less noisily as they are common in multi-instance environments
        if (error.message?.includes('409') || error.message?.includes('conflict')) {
          console.warn('[Telegram Bot] Polling conflict (likely multiple instances). This is expected on Cloud Run.');
        } else {
          console.error('[Telegram Bot] Polling Error:', error.message);
        }
      });

      console.log('[Telegram Bot] Initialized successfully');

      // Handle /start command
      bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, "أهلاً بك يا صديقي في *AI DocScanner*! 😊\n\nأنا هنا لخدمتك.. فقط أرسل لي صورة لأي إيصال، بطاقة عمل، أو مستند وسأقوم بتحليله لك فوراً بلمسة من الذكاء الاصطناعي.\n\nتفضل، أنا تحت أمرك في أي وقت! ✨", { parse_mode: 'Markdown' });
      });

      bot.on('callback_query', async (query) => {
        const chatId = query.message?.chat.id;
        if (!chatId) return;

        const lastScan = userScans.get(chatId);

        if (query.data === 'print_doc' || query.data === 'save_pdf') {
          if (!lastScan) {
            bot.answerCallbackQuery(query.id, { text: "عذراً، لم يتم العثور على بيانات المستند." });
            bot.sendMessage(chatId, "❌ لا توجد بيانات محفوظة لهذا المستند. يرجى إعادة إرسال الصورة.");
            return;
          }

          bot.answerCallbackQuery(query.id, { text: query.data === 'print_doc' ? "حاضر، جاري تحضير الطباعة... 🖨️" : "أبشر، جاري إنشاء ملف PDF... 📄" });
          
          try {
            const doc = new PDFDocument({ margin: 20, size: 'A4' });
            const chunks: Buffer[] = [];
            
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', async () => {
              const pdfBuffer = Buffer.concat(chunks);
              const filename = `Print_Scan_${Date.now()}.pdf`;
              
              await bot.sendDocument(chatId, pdfBuffer, {
                caption: query.data === 'print_doc' ? "🖨️ *جاهز للطباعة* | تم تحسين الصورة والمقاسات لتناسب ورق A4" : "📄 *مستند PDF المصدر* | يحتوي على البيانات المستخرجة",
                filename: filename,
                parse_mode: 'Markdown'
              });
            });

            const cached = imageCache.get(lastScan.scanId);
            if (cached) {
              if (query.data === 'print_doc') {
                // If it's for printing, let the image take priority and fill the page
                doc.image(cached.buffer, {
                  fit: [555, 802], 
                  align: 'center',
                  valign: 'center'
                });
              } else {
                // Standard PDF Report layout
                doc.fontSize(25).text('AI DocScanner Report', { align: 'center' });
                doc.moveDown();
                
                doc.image(cached.buffer, {
                  fit: [500, 400],
                  align: 'center',
                  valign: 'center'
                });
                doc.moveDown();

                doc.fontSize(12).text(`Date: ${new Date().toLocaleString()}`);
                doc.text(`Classification: ${lastScan.classification.toUpperCase()}`);
                doc.moveDown();
                doc.fontSize(16).text('Extracted Metadata:');
                doc.moveDown(0.5);
                
                if (lastScan.metadata) {
                  Object.entries(lastScan.metadata).forEach(([key, value]) => {
                    doc.fontSize(12).font('Helvetica-Bold').text(`${key.replace(/_/g, ' ').toUpperCase()}: `, { continued: true });
                    doc.font('Helvetica').text(String(value));
                    doc.moveDown(0.5);
                  });
                }
                
                doc.moveDown(1);
                doc.fontSize(10).fillColor('gray').text('Generated by AI DocScanner Bot', { align: 'center' });
              }
            } else {
              doc.fontSize(20).text('Document Image Not Found', { align: 'center' });
            }
            
            doc.end();
          } catch (pdfErr) {
            console.error('PDF Generation Error:', pdfErr);
            bot.sendMessage(chatId, "❌ حدث خطأ أثناء إنشاء ملف PDF.");
          }
        }
      });

      bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const fileId = msg.photo?.[msg.photo.length - 1].file_id || (msg.document?.mime_type?.startsWith('image/') ? msg.document.file_id : null);
        
        if (!fileId || msg.text?.startsWith('/')) return;

        console.log(`[Telegram Bot] Image/Document received from chatId: ${chatId}`);
        let processedBuffer: Buffer | null = null;
        let scanId: string = uuidv4();

        try {
          await bot.sendMessage(chatId, "من عيوني! جاري تحليل المستند وتحسين جودته... 🔍\nيرجى الانتظار لحظة يا غالي ⏳", { parse_mode: 'Markdown' });
          bot.sendChatAction(chatId, 'upload_document');
          
          const fileLink = await bot.getFileLink(fileId);
          console.log('[Telegram Bot] Processing image from:', fileLink);
          
          const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
          const inputBuffer = Buffer.from(response.data);
          
          // Processing Image: Professional Document Enhancement (Intelligent Tone & Edge Trimming)
          processedBuffer = await sharp(inputBuffer)
            .rotate()               // Handle phone camera rotation
            .median(3)              // Smooth noise to help trim logic
            .extend({               // Pad with pure white to ensure background is identified
              top: 30, bottom: 30, left: 30, right: 30, 
              background: { r: 255, g: 255, b: 255 } 
            })
            .trim({ threshold: 80 }) // Trim anything very light/white
            .toBuffer()
            .then(buf => sharp(buf)
              .modulate({ brightness: 1.05 })
              .clahe({ width: 150, height: 150, maxSlope: 3 }) // Balanced adaptive contrast
              .linear(1.2, -10)     // Gentle global contrast boost (prevents 'burnt' look)
              .sharpen({
                sigma: 1.2,         // Crisp text edges
                m1: 10.0,
                m2: 20
              })
              .normalize()          // Re-balance color distribution
              .toBuffer()
              .then(b => sharp(b)
                .trim({ threshold: 40 }) // Final micro-refinement trim
                .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
                .toBuffer()
              )
            );

          const base64 = processedBuffer.toString('base64');
          
          // Store in cache for print/view action
          imageCache.set(scanId, { buffer: processedBuffer, mimeType: 'image/jpeg' });
          
          let responseMsg = `🖼️ *معاينة المستند المستخرجة*\n` +
                            `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n`;
          let hasMetadata = false;

          try {
            const prompt = `
              Identify and classify this document (receipt, business_card, id_card, or other).
              Extract key metadata into a clean JSON object. 
              Support Arabic and English text extraction.
            `;
            
            const model = getAiModel();
            const result = await model.generateContent({
              model: 'gemini-1.5-flash',
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
            
            if (resultText) {
              const data = JSON.parse(resultText);
              data.scanId = scanId; 
              userScans.set(chatId, data);
              
              const typeMap: Record<string, string> = {
                'receipt': '🧾 إيصال / فاتورة',
                'business_card': '📇 بطاقة عمل',
                'id_card': '🪪 بطاقة هوية',
                'other': '📄 مستند عام'
              };
              
              responseMsg += `🏷️ *التصنيف:* ${typeMap[data.classification] || data.classification || 'غير معروف'}\n`;
              
              if (data.metadata && typeof data.metadata === 'object') {
                responseMsg += `\n🔍 *البيانات المكتشفة:*\n`;
                for (const [key, value] of Object.entries(data.metadata)) {
                  if (value && String(value).trim()) {
                    const label = key.replace(/_/g, ' ').toUpperCase();
                    responseMsg += `  • *${label}:* \`${value}\`\n`;
                  }
                }
              }
              hasMetadata = true;
            }
          } catch (aiErr: any) {
            console.error('[Telegram Bot] AI Analysis Step Failed:', aiErr);
            const errString = typeof aiErr === 'string' ? aiErr : (aiErr.message || JSON.stringify(aiErr));
            
          if (errString.includes('429') || errString.includes('quota') || errString.includes('RESOURCE_EXHAUSTED')) {
            console.warn('[Telegram Bot] Gemini Quota Exceeded (429)');
            responseMsg += "⚠️ *أبشر.. تم تحسين جودة الصورة بنجاح!* لكن يبدو أننا وصلنا للحد الأقصى من التحليلات التلقائية المتقدمة حالياً.\n\nلا تقلق، يمكنك طباعة الصورة المحسنة (بجودة احترافية) أو حفظها كـ PDF فوراً باستخدام الأزرار أدناه! أنا دائماً في خدمتك. ✨";
          } else if (errString.includes('503') || errString.includes('UNAVAILABLE') || errString.includes('high demand')) {
            console.warn('[Telegram Bot] Gemini Service Unavailable (503)');
            responseMsg += "⚠️ *تم تحسين الصورة لتكون واضحة جداً!* تعذر استخراج البيانات حالياً بسبب ضغط على الخدمة، ولكن الصورة جاهزة للطباعة الآن. ✨";
          } else {
            console.error('[Telegram Bot] AI Analysis Step Failed:', aiErr);
            responseMsg += "⚠️ *تمت المعالجة بنجاح!* قمت بتحسين وضوح الصورة وقص الحواف، وهي الآن جاهزة للطباعة أو الحفظ كـ PDF. تحت أمرك! ✨";
          }
            // Save minimal state for print
            userScans.set(chatId, { scanId, classification: 'document', metadata: {} });
          }

          if (hasMetadata) {
            responseMsg += `\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                           `✅ *تمت المعالجة بنجاح. أنت تؤمر!*`;
          }

          const keyboard = {
            inline_keyboard: [
              [
                { text: "طباعة المستند 🖨️", callback_data: "print_doc" },
                { text: "حفظ كـ PDF 📄", callback_data: "save_pdf" }
              ]
            ]
          };

          // Send the processed photo with the extraction result or status as caption
          await bot.sendPhoto(chatId, processedBuffer, { 
            caption: responseMsg,
            parse_mode: 'Markdown',
            reply_markup: keyboard
          }).catch(async (e) => {
            console.warn('[Telegram Bot] sendPhoto with caption failed, falling back to message:', e.message);
            await bot.sendPhoto(chatId, processedBuffer!);
            await bot.sendMessage(chatId, responseMsg, { 
              parse_mode: 'Markdown', 
              reply_markup: keyboard 
            }).catch(() => {
              bot.sendMessage(chatId, responseMsg.replace(/[*_`]/g, ''), { reply_markup: keyboard });
            });
          });

        } catch (err: any) { 
          console.error('[Telegram Bot] Fatal Photo Handler Error:', err);
          let userMsg = `❌ واجهت مشكلة في معالجة الصورة.\n\nالتفاصيل: ${err.message || 'خطأ غير معروف'}`;
          bot.sendMessage(chatId, userMsg); 
        }
      });

      bot.on('message', async (msg) => {
        if (msg.photo || !msg.text || msg.text.startsWith('/')) return;
        
        const chatId = msg.chat.id;
        try {
          const model = getAiModel();
          const result = await model.generateContent({
             model: 'gemini-1.5-flash',
             contents: `أنت مساعد ذكي وودي جداً لتطبيق AI DocScanner. رد باللغة العربية بطريقة بشرية مهذبة (مثل: تحت أمرك، أبشر، من عيوني) على: ${msg.text}`
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
          
          if (errString.includes('429') || errString.includes('quota') || errString.includes('RESOURCE_EXHAUSTED')) {
            console.warn('[Telegram Bot] Gemini Chat Quota Exceeded');
            errorText = "أعتذر منك يا غالي، وصلنا للحد الأقصى المسموح به من الطلبات حالياً ⚠️\n\nالخدمة ستعود للعمل تلقائياً قريباً. يمكنك دائماً إرسال الصور لمعالجتها حتى لو توقف الدردشة! 😊";
          } else if (errString.includes('503') || errString.includes('UNAVAILABLE') || errString.includes('high demand')) {
            errorText = "عذراً يا صديقي، هناك ضغط كبير على الخدمة حالياً 😅\n\nيرجى المحاولة بعد دقيقة وسأقوم بالرد عليك فوراً. تحت أمرك! ✨";
          } else if (errString.includes('API_KEY_INVALID') || errString.includes('API key not valid') || errString.includes('INVALID_ARGUMENT') || errString.includes('GEMINI_API_KEY_MISSING')) {
            errorText = "❌ مفتاح API الخاص بـ Gemini غير صحيح أو مفقود. يرجى التحقق من الإعدادات > Secrets وإضافة GEMINI_API_KEY صحيح.";
          } else if (errString.includes('PERMISSION_DENIED')) {
            errorText = "❌ تم رفض الوصول (Permission Denied). يرجى التأكد من أن مفتاح API لديه الصلاحيات اللازمة (Settings > Secrets).";
          } else if (err.message?.includes('SAFETY')) {
            errorText = "عذراً، لا يمكنني الاستجابة لهذا النوع من الرسائل لسياسات الأمان.";
          } else if (err.response?.promptFeedback?.blockReason) {
            errorText = `عذراً، تم حظر الرد لسبب: ${err.response.promptFeedback.blockReason}`;
          }
          bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
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
    // Capture host for bot links
    const host = req.get('host');
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      currentHost = host;
    }
    const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.length > 5);
    const hasGemini = Boolean(process.env.GEMINIAPIKEY || process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY);
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
        model: 'gemini-1.5-flash',
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

  // Print Page Route
  app.get('/print/:id', (req, res) => {
    const id = req.params.id;
    const cached = imageCache.get(id);
    if (!cached) return res.status(404).send('Document not found or expired.');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>DocPrint - AI DocScanner</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            min-height: 100vh; 
            margin: 0; 
            background: #f4f4f7; 
            font-family: sans-serif;
          }
          .container { 
            background: white; 
            padding: 20px; 
            box-shadow: 0 4px 12px rgba(0,0,0,0.1); 
            border-radius: 8px; 
            max-width: 90%;
            text-align: center;
          }
          img { max-width: 100%; border: 1px solid #ddd; margin-bottom: 20px; }
          .btn { 
            background: #0088cc; 
            color: white; 
            padding: 12px 24px; 
            border: none; 
            border-radius: 6px; 
            font-size: 18px; 
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
          }
          @media print {
            .btn { display: none; }
            body { background: white; }
            .container { box-shadow: none; padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <img src="/image/${id}" alt="Scanned Document">
          <br>
          <button class="btn" onclick="window.print()">🖨️ طباعة المستند الآن</button>
        </div>
      </body>
      </html>
    `);
  });

  // Serve image from cache
  app.get('/image/:id', (req, res) => {
    const cached = imageCache.get(req.params.id);
    if (!cached) return res.status(404).send('Not found');
    res.set('Content-Type', cached.mimeType);
    res.send(cached.buffer);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
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
    console.log(`[Server] Listening on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
  });
}

startServer();
