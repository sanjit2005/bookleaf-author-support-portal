import { emitKeypressEvents } from 'node:readline';
import { ProvisionError } from './account.js';
import { validPasswordCharacters } from '../auth/password-policy.js';

// Raw terminal input avoids readline echo, including when passwords are pasted.
export function promptLine(label,{secret=false,input=process.stdin,output=process.stdout,signal}={}) {
  if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function') return Promise.reject(new ProvisionError('TERMINAL'));
  if(signal?.aborted) return Promise.reject(new ProvisionError('INTERRUPTED'));
  return new Promise((resolve,reject)=>{
    const previousRaw=Boolean(input.isRaw),flowing=input.readableFlowing;
    const characters=[];
    let finished=false;
    function finish(error) {
      if(finished) return;
      finished=true;
      input.off('keypress',onKey);input.off('end',onEnd);input.off('close',onEnd);input.off('error',onEnd);signal?.removeEventListener('abort',onAbort);
      try {input.setRawMode(previousRaw);} catch { /* terminal may already be closed */ }
      if(flowing!==true) input.pause();
      try {output.write('\n');} catch { /* output may already be closed */ }
      const value=characters.join('');characters.length=0;
      if(error) reject(error);else resolve(value);
    }
    function onEnd(){finish(new ProvisionError('INTERRUPTED'));}
    function onAbort(){finish(new ProvisionError('INTERRUPTED'));}
    function onKey(text,key={}) {
      if(key.ctrl&&['c','d'].includes(key.name)) return onAbort();
      if(['return','enter'].includes(key.name)) return finish();
      if(['backspace','delete'].includes(key.name)) {if(characters.length){characters.pop();if(!secret)output.write('\b \b');}return;}
      if(secret && (key.ctrl||key.meta||!text||!validPasswordCharacters(text))) return finish(new ProvisionError('PASSWORD_INPUT'));
      if(key.ctrl||key.meta||!text||/[\x00-\x1f\x7f]/.test(text)) return;
      characters.push(...Array.from(text));
      if(characters.length>1024) return finish(new ProvisionError(secret?'PASSWORD':'EMAIL'));
      if(!secret) output.write(text);
    }
    emitKeypressEvents(input);
    input.on('keypress',onKey);input.once('end',onEnd);input.once('close',onEnd);input.once('error',onEnd);signal?.addEventListener('abort',onAbort,{once:true});
    try {output.write(label);input.setRawMode(true);input.resume();}
    catch {finish(new ProvisionError('TERMINAL'));}
  });
}
