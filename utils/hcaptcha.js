async function verifyHCaptcha(token, remoteip) {
  const secret = process.env.HCAPTCHA_SECRET;
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);
    if (remoteip) form.append('remoteip', remoteip);
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await res.json();
    return !!data.success;
  } catch (e) {
    console.error('hcaptcha verify error', e);
    return false;
  }
}

module.exports = { verifyHCaptcha };
