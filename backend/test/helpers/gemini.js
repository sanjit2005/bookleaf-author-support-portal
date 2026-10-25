// Synthetic Gemini Developer API wire response; no SDK/network calls here.
export const geminiResponse=value=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:typeof value==='string'?value:JSON.stringify(value)}]}}]}));
