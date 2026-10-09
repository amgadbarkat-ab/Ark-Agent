import type { AuthProviderId } from "../config";

/** Browser half of Better Auth's official desktop transfer; OAuth remains with Better Auth. */
export function desktopAuthPage(
  request: Request,
  providers: readonly AuthProviderId[],
): Response {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  let redirect: URL;
  try {
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    return new Response("Invalid desktop callback.", { status: 400 });
  }
  if (
    !providers.some((value) => value === provider) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    !redirect.port ||
    redirect.pathname !== "/organization-auth/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    return new Response("Invalid desktop sign-in configuration.", {
      status: 400,
    });
  }
  const config = JSON.stringify({
    provider,
    state,
    challenge,
    redirect: redirect.href,
    callback: url.href,
  }).replaceAll("<", "\\u003c");
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in to ArkAgent</title></head><body><main><h1>Sign in to ArkAgent</h1><p id="status">Continue with your organization account to return to ArkAgent.</p><button id="continue">Continue</button></main><script nonce="${nonce}">
const config=${config};
const status=document.getElementById('status');
const button=document.getElementById('continue');
const query=new URLSearchParams({client_id:'openbot-desktop',state:config.state,code_challenge:config.challenge});
async function proceed(){button.disabled=true;try{
 const transfer=await fetch('/api/auth/electron/transfer-user?'+query,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'});
 if(transfer.ok){const grant=await transfer.json();if(typeof grant.electron_authorization_code!=='string')throw new Error('Sign-in did not return a code.');const target=new URL(config.redirect);target.searchParams.set('code',grant.electron_authorization_code);target.searchParams.set('state',config.state);location.replace(target.href);return;}
 if(transfer.status!==401)throw new Error('Your organization could not authorize this sign-in.');
 const response=await fetch('/api/auth/sign-in/social?'+query,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({provider:config.provider,callbackURL:config.callback})});
 const result=await response.json();if(!response.ok||typeof result.url!=='string')throw new Error('Your organization could not start sign-in.');location.assign(result.url);
}catch(error){status.textContent=error.message;button.disabled=false;}}
button.addEventListener('click',proceed);
</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

/** Where the iOS app is opened after sign-in. The path is fixed so a scheme alone is not a destination. */
export const APP_RETURN_HOST = "signed-in";

/** Providers that Better Auth signs in through `sign-in/social`, which is all this page starts. */
const APP_PROVIDERS = ["google", "microsoft"] as const;

/**
 * The page the iOS app opens in the system browser to sign somebody in, and to hand the result back.
 *
 * WHY A BROWSER AT ALL. Google refuses to sign anybody in inside an embedded web view, and the app is
 * one. So the app opens this page in the system browser, which can sign in with any provider, and
 * the browser sends a one-time code back by opening the app's own address.
 *
 * WHAT STOPS THE CODE BEING USED BY SOMEBODY ELSE. Two apps can claim the same scheme, so the code in
 * the address cannot be a session. It is Better Auth's own transfer code (the one the desktop app
 * used): bound to a challenge the app chose, and redeemable only with the secret that produced it,
 * which never leaves the app. It works once and expires in two minutes. The exchange creates a
 * session of its own (`/api/auth/electron/token`), so the browser's session is not the app's.
 *
 * WHAT STOPS A LINK SIGNING SOMEBODY INTO THE APP WITHOUT THEM KNOWING. Starting a sign-in is
 * harmless and happens by itself. Handing a signed-in session to the app does not: that needs a tap,
 * on a button that says which account it is.
 */
export function appAuthPage(
  request: Request,
  providers: readonly AuthProviderId[],
  scheme: string,
): Response {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const redirect = url.searchParams.get("redirect_uri") ?? "";
  if (
    !providers.some((value) => value === provider) ||
    !APP_PROVIDERS.some((value) => value === provider) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    redirect !== `${scheme}://${APP_RETURN_HOST}`
  ) {
    return new Response("Invalid app sign-in configuration.", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  const config = JSON.stringify({
    provider,
    state,
    challenge,
    redirect,
    callback: url.href,
  }).replaceAll("<", "\\u003c");
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title></head><body><main style="font-family:system-ui,sans-serif;max-width:24rem;margin:20vh auto;padding:0 1rem;text-align:center"><h1 style="font-size:1.4rem">Sign in</h1><p id="status">Opening sign-in…</p><button id="continue" hidden style="font-size:1rem;padding:.7rem 1.2rem">Continue to the app</button></main><script nonce="${nonce}">
const config=${config};
const status=document.getElementById('status');
const button=document.getElementById('continue');
const query=new URLSearchParams({client_id:'openbot-desktop',state:config.state,code_challenge:config.challenge});
const json={'content-type':'application/json'};
function fail(message){status.textContent=message;button.hidden=true;}
async function signIn(){
 const response=await fetch('/api/auth/sign-in/social?'+query,{method:'POST',credentials:'include',headers:json,body:JSON.stringify({provider:config.provider,callbackURL:config.callback})});
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result||typeof result.url!=='string')throw new Error('Sign-in could not be started.');
 location.assign(result.url);
}
async function hand(){
 button.disabled=true;
 try{
  const response=await fetch('/api/auth/electron/transfer-user?'+query,{method:'POST',credentials:'include',headers:json,body:'{}'});
  const grant=await response.json().catch(()=>null);
  if(!response.ok||!grant||typeof grant.electron_authorization_code!=='string')throw new Error('Signing in could not be completed. Go back to the app and try again.');
  const target=new URL(config.redirect);
  target.searchParams.set('code',grant.electron_authorization_code);
  target.searchParams.set('state',config.state);
  location.replace(target.href);
 }catch(error){fail(error.message);}
}
button.addEventListener('click',hand);
(async()=>{
 try{
  const response=await fetch('/api/auth/get-session',{credentials:'include'});
  const session=response.ok?await response.json().catch(()=>null):null;
  if(session&&session.user&&typeof session.user.email==='string'){
   status.textContent='Continue to the app as '+session.user.email+'?';
   button.hidden=false;
   return;
  }
  await signIn();
 }catch(error){fail(error.message);}
})();
</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
