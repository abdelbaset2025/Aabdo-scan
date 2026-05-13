import React, { useState, useRef, useEffect } from 'react';
import { Camera, Image as ImageIcon, CheckCircle2, RotateCcw, MousePointer2, Terminal, Cpu, Share2, Download, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Point {
  x: number;
  y: number;
}

interface Corners {
  top_left: Point;
  top_right: Point;
  bottom_right: Point;
  bottom_left: Point;
}

interface ScanMetadata {
  vendor?: string;
  total?: string;
  currency?: string;
  date?: string;
  person_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  document_number?: string;
  description?: string;
}

export default function App() {
  const [status, setStatus] = useState({ telegram: false, gemini: false });

  useEffect(() => {
    fetch('/api/status')
      .then(res => res.json())
      .then(data => setStatus({ telegram: data.telegramActive, gemini: data.geminiActive }))
      .catch(() => setStatus({ telegram: false, gemini: false }));
  }, []);

  const TELEGRAM_ACTIVE = status.telegram;
  const GEMINI_ACTIVE = status.gemini;

  const [image, setImage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [corners, setCorners] = useState<Corners | null>(null);
  const [classification, setClassification] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ScanMetadata | null>(null);
  const [scannedImage, setScannedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImage(URL.createObjectURL(file));
    setIsScanning(true);
    setCorners(null);
    setClassification(null);
    setMetadata(null);
    setScannedImage(null);

    const formData = new FormData();
    formData.append('document', file);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (data.success) {
        setCorners(data.corners);
        setClassification(data.classification);
        setMetadata(data.metadata);
        setTimeout(() => {
          performVirtualScan(data.originalImage);
          setIsScanning(false);
        }, 1500);
      }
    } catch (error) {
      console.error('Scan failed:', error);
      setIsScanning(false);
    }
  };

  const performVirtualScan = (originalSrc: string) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      const width = 800;
      const height = 1100;
      canvas.width = width;
      canvas.height = height;

      if (ctx) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const gray = (r + g + b) / 3;
          const val = gray > 180 ? 255 : gray < 50 ? 0 : (gray - 50) * (255 / 130);
          data[i] = val;
          data[i + 1] = val;
          data[i + 2] = val;
        }
        
        ctx.putImageData(imageData, 0, 0);
        setScannedImage(canvas.toDataURL('image/jpeg', 0.9));
      }
    };
    img.src = originalSrc;
  };

  const reset = () => {
    setImage(null);
    setCorners(null);
    setClassification(null);
    setMetadata(null);
    setScannedImage(null);
    setIsScanning(false);
  };

  return (
    <div className="min-h-screen w-full bg-[#f8fafc] text-slate-900 flex flex-col font-sans">
      {/* Top Header */}
      <header className="min-h-16 bg-slate-900 text-white flex flex-col md:flex-row items-center justify-between px-4 md:px-8 py-4 md:py-0 shrink-0 shadow-lg z-20 gap-4 md:gap-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center font-bold text-lg shrink-0">W</div>
          <h1 className="text-lg md:text-xl font-semibold tracking-tight">
            AI DocScanner Bot <span className="hidden sm:inline text-emerald-400 font-mono text-xs md:text-sm uppercase ml-2 px-2 py-0.5 border border-emerald-400/30 rounded">Gemini 3 + Telegram</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 md:gap-6 text-sm font-medium opacity-80 w-full md:w-auto justify-between md:justify-end">
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="bg-emerald-500 hover:bg-emerald-600 text-slate-900 px-4 py-1.5 rounded-md font-bold transition-all flex items-center gap-2 text-xs md:text-sm"
          >
            <ImageIcon className="w-4 h-4" />
            Upload Source
          </button>
          <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
          
          <div className="hidden md:block h-4 w-px bg-slate-700"></div>
          <span className="flex items-center gap-2 text-xs md:text-sm whitespace-nowrap">
            <div className={`w-2 h-2 rounded-full ${isScanning ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-400'}`}></div> 
            {isScanning ? 'AI Engine Running' : 'System Active'}
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 md:p-6 grid grid-cols-1 md:grid-cols-12 gap-6 grid-bg">
        
        {/* Left Side: Pipeline Logic */}
        <div className="col-span-1 md:col-span-4 lg:col-span-3 flex flex-col gap-4 order-2 md:order-1">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm flex flex-col h-full">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 mb-6">Extraction Insights</h2>
            
            <AnimatePresence>
              {classification ? (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex-1"
                >
                  <div className="mb-4">
                    <span className="text-[9px] font-bold bg-indigo-50 text-indigo-600 px-2 py-1 rounded-sm uppercase tracking-widest">Classification</span>
                    <p className="text-lg font-bold capitalize mt-1 text-slate-800">{classification.replace('_', ' ')}</p>
                  </div>

                  {metadata && (
                    <div className="space-y-4">
                      {metadata.vendor && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Vendor</p>
                          <p className="text-sm font-semibold">{metadata.vendor}</p>
                        </div>
                      )}
                      {metadata.total && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Total Amount</p>
                          <p className="text-sm font-semibold text-emerald-600">{metadata.currency} {metadata.total}</p>
                        </div>
                      )}
                      {metadata.person_name && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Person Name</p>
                          <p className="text-sm font-semibold">{metadata.person_name}</p>
                        </div>
                      )}
                      {metadata.company && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Company</p>
                          <p className="text-sm font-semibold">{metadata.company}</p>
                        </div>
                      )}
                      {metadata.email && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Email</p>
                          <p className="text-sm font-semibold text-indigo-600 underline truncate">{metadata.email}</p>
                        </div>
                      )}
                      {metadata.date && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Date</p>
                          <p className="text-sm font-semibold">{metadata.date}</p>
                        </div>
                      )}
                      {metadata.description && (
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase">Description</p>
                          <p className="text-[11px] text-slate-600 leading-tight">{metadata.description}</p>
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
                  <Cpu className="w-8 h-8 text-slate-200 mb-2" />
                  <p className="text-xs text-slate-400 italic leading-tight">Gemini is standing by to extract semantic data from your scan.</p>
                </div>
              )}
            </AnimatePresence>

            <div className="mt-8 p-4 bg-slate-50 rounded-lg border border-slate-200">
              <p className="text-[10px] uppercase font-bold text-slate-400 mb-2">Telegram Setup</p>
              <div className="flex flex-col gap-2">
                <p className="text-[10px] text-slate-500 leading-tight">1. Create a bot via @BotFather</p>
                <p className="text-[10px] text-slate-500 leading-tight">2. Add TELEGRAM_BOT_TOKEN to Secrets</p>
                <p className="text-[10px] text-slate-500 leading-tight">3. Bot starts listening automatically</p>
              </div>
            </div>
          </div>
        </div>

        {/* Center: Live Action / Preview */}
        <div className="col-span-1 md:col-span-8 lg:col-span-6 flex flex-col gap-6 order-1 md:order-2">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm h-full flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-indigo-600">Part 1: Real-time Analysis</h2>
              {image && (
                <button onClick={reset} className="text-[10px] uppercase font-bold text-slate-400 hover:text-red-500 flex items-center gap-1 transition-colors">
                  <RotateCcw className="w-3 h-3" /> Reset Session
                </button>
              )}
            </div>
            
            <div className="flex-1 bg-slate-900 rounded-lg relative overflow-hidden flex items-center justify-center p-4">
              {!image ? (
                <div className="text-center">
                  <div className="w-20 h-20 rounded-2xl bg-slate-800 border-2 border-dashed border-slate-700 flex items-center justify-center mx-auto mb-4">
                    <Zap className="w-10 h-10 text-slate-600" />
                  </div>
                  <p className="text-slate-500 text-sm italic">Waiting for Input Stream...</p>
                </div>
              ) : (
                <div className="relative w-full h-full flex items-center justify-center">
                  <img src={image} className="max-h-full max-w-full rounded shadow-2xl transition-opacity duration-300" style={{ opacity: isScanning ? 0.4 : 0.8 }} />
                  
                  {isScanning && (
                    <motion.div 
                      initial={{ top: '0%' }}
                      animate={{ top: '100%' }}
                      transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                      className="absolute left-0 w-full h-1 bg-emerald-400 shadow-[0_0_15px_#10b981] z-10"
                    />
                  )}

                  {corners && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <motion.polygon 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.3 }}
                        className="fill-emerald-400/20 stroke-emerald-400 stroke-[0.3]"
                        points={`${corners.top_left.x},${corners.top_left.y} ${corners.top_right.x},${corners.top_right.y} ${corners.bottom_right.x},${corners.bottom_right.y} ${corners.bottom_left.x},${corners.bottom_left.y}`}
                      />
                      {Object.entries(corners).map(([key, point]) => {
                        const p = point as Point;
                        return <circle key={key} cx={p.x} cy={p.y} r="1.5" fill="#10b981" />;
                      })}
                    </svg>
                  )}
                  
                  <div className="absolute top-4 left-4 flex gap-2">
                    <span className="text-[10px] bg-slate-950/80 text-emerald-400 px-2 py-1 rounded-sm border border-emerald-400/30 backdrop-blur-sm flex items-center gap-1">
                      <Cpu className="w-3 h-3" /> STREAM: ACTIVE
                    </span>
                    {corners && (
                      <span className="text-[10px] bg-indigo-500 text-white px-2 py-1 rounded-sm shadow-lg flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> VERTICES CALIBRATED
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Code Snippets Section */}
            <div className="mt-4 grid grid-cols-2 gap-4 h-48">
              <div className="bg-slate-950 rounded-lg p-3 text-[10px] font-mono text-indigo-300 overflow-hidden border border-white/5">
                <p className="text-white/40 mb-1">// Gemini System Prompt</p>
                <p>Detect 4 primary corners.</p>
                <p className="text-white">Format: JSON</p>
                <p className="text-emerald-400 mt-1">{"{"}</p>
                <p className="text-emerald-400 px-2">"vertices": {"{"}</p>
                <p className="text-emerald-400 px-4">"tl": [x, y], "tr": [x, y],</p>
                <p className="text-emerald-400 px-4">"br": [x, y], "bl": [x, y]</p>
                <p className="text-emerald-400 px-2">{"}"}</p>
                <p className="text-emerald-400">{"}"}</p>
              </div>
              <div className="bg-slate-950 rounded-lg p-3 text-[10px] font-mono text-slate-400 overflow-hidden border border-white/5">
                <p className="text-white/40 mb-1"># OpenCV Backend Implementation</p>
                <p className="text-blue-400">def warp_doc(image, pts):</p>
                <p className="px-2">M = cv2.getPerspectiveTransform(src, dst)</p>
                <p className="px-2">warped = cv2.warpPerspective(img, M)</p>
                <p className="px-2 text-emerald-500 mt-1"># Clear Scan Finish</p>
                <p className="px-2">thresh = cv2.adaptiveThreshold(gray, 255)</p>
                <p className="px-2">return cv2.encode('.pdf', thresh)</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Visual Benchmarks */}
        <div className="col-span-1 md:col-span-12 lg:col-span-3 flex flex-col gap-4 order-3">
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm h-full flex flex-col">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 mb-6">Visual Benchmark</h2>
            
            <div className="flex-1 flex flex-col gap-6 overflow-y-auto pr-1">
               {/* Before Mock */}
              <div className="relative group">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">1. Mobile Ingress</p>
                  <span className={`text-[9px] px-1.5 rounded-sm ${image ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}>
                    {image ? 'Captured' : 'Perspective Detection'}
                  </span>
                </div>
                <div className="w-full aspect-[3/4] bg-slate-100 rounded-lg flex items-center justify-center border border-slate-200 overflow-hidden shadow-inner group-hover:border-slate-300 transition-all">
                  <div className={`w-3/4 h-3/5 bg-white shadow-xl border border-slate-300 transition-transform duration-700 ${image ? 'transform rotate-0' : 'transform -rotate-12 translate-x-1'} flex items-center justify-center relative`}>
                    <div className="w-4/5 h-px bg-slate-100 absolute top-4"></div>
                    <div className="w-3/5 h-px bg-slate-100 absolute top-8"></div>
                    <div className="w-4/5 h-px bg-slate-100 absolute top-12"></div>
                    {image && <div className="absolute inset-0 bg-emerald-50/20 flex items-center justify-center text-emerald-500/20"><CheckCircle2 className="w-8 h-8" /></div>}
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center flex-shrink-0">
                <div className="w-0.5 h-6 bg-slate-200 relative">
                  <div className="absolute -bottom-1 -left-[5px] w-3 h-3 bg-slate-200 rotate-45 border-b border-r border-transparent"></div>
                </div>
              </div>

              {/* After Mock / Real Scan Result */}
              <div className="relative">
                <div className="flex justify-between items-center mb-2">
                  <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-tighter">2. AI-Scanner Output</p>
                  {scannedImage && <span className="text-[9px] bg-emerald-100 text-emerald-600 px-1.5 rounded-sm animate-bounce">Verified</span>}
                </div>
                <div className={`w-full aspect-[3/4] bg-white rounded-lg flex items-center justify-center border-2 ${scannedImage ? 'border-emerald-500' : 'border-slate-200'} shadow-md overflow-hidden relative group`}>
                   {scannedImage ? (
                     <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="p-4 w-full h-full">
                       <img src={scannedImage} className="w-full h-full object-contain" />
                       <div className="absolute top-2 right-2 flex gap-2">
                          <button className="p-1.5 bg-emerald-500 text-white rounded-full shadow-lg hover:bg-emerald-600 transition-colors"><Download className="w-3 h-3"/></button>
                          <button className="p-1.5 bg-white text-slate-700 rounded-full shadow-lg hover:bg-slate-50 transition-colors border border-slate-200"><Share2 className="w-3 h-3"/></button>
                       </div>
                     </motion.div>
                   ) : (
                     <div className="w-11/12 h-[90%] bg-slate-50 flex flex-col p-4 opacity-30">
                        <div className="h-1 w-full bg-slate-200 mb-2"></div>
                        <div className="h-1 w-3/4 bg-slate-200 mb-6"></div>
                        {[...Array(8)].map((_, i) => (
                           <div key={i} className="h-0.5 w-full bg-slate-100 mb-1.5"></div>
                        ))}
                     </div>
                   )}
                   <div className="absolute top-2 right-2 px-1.5 py-0.5 bg-emerald-500 text-white text-[8px] font-bold rounded uppercase tracking-tighter shadow-sm z-10">300 DPI CLEAR</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="min-h-10 bg-white border-t border-slate-200 flex flex-col sm:flex-row items-center px-4 md:px-8 py-2 sm:py-0 justify-between text-[10px] font-semibold text-slate-500 shrink-0 z-20 gap-2 sm:gap-4">
        <div className="flex flex-wrap gap-2 md:gap-4 items-center justify-center">
          <span className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${GEMINI_ACTIVE ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`}></div>
            GEMINI: {GEMINI_ACTIVE ? 'READY' : 'KEY MISSING'}
          </span>
          <div className="hidden sm:block h-3 w-px bg-slate-200 mx-1"></div>
          <span className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${TELEGRAM_ACTIVE ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`}></div>
            TELEGRAM: {TELEGRAM_ACTIVE ? 'ACTIVE' : 'OFFLINE'}
          </span>
          {(!TELEGRAM_ACTIVE || !GEMINI_ACTIVE) && (
            <span className="text-red-400 font-normal italic">
              Missing: {!GEMINI_ACTIVE && 'GEMINIAPIKEY'} {!TELEGRAM_ACTIVE && ' & TELEGRAM_BOT_TOKEN'}
            </span>
          )}
        </div>
        <div className="flex gap-4 uppercase tracking-widest items-center">
          <span className="text-emerald-600 flex items-center gap-1 tracking-normal font-sans text-[9px]"><div className="w-1 h-1 bg-emerald-500 rounded-full"></div> VISION-PRO 4.8</span>
          <div className="hidden sm:block h-3 w-px bg-slate-200 mx-1"></div>
          <span>© 2026 AI-DOCSCAN</span>
        </div>
      </footer>
    </div>
  );
}
