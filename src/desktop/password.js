let request = {purpose: 'open', minLength: 1, maxBytes: 1024};
const field = id => document.querySelector(id);
// The library counts the bytes of the password after Unicode normalisation (NFC); so does the main process, and so must this page, or the three disagree.
const bytes = text => new TextEncoder().encode(text.normalize('NFC')).length;
window.password.onRequest(value => {
  request = value;
  field('#title').textContent = value.purpose === 'create' ? 'New Document Password' : 'Unlock Document';
  field('#name').textContent = value.name;
  field('#error').textContent = value.error;
  field('#confirm-row').hidden = value.purpose !== 'create';
  field('#hint').hidden = value.purpose !== 'create';
  field('#remember-row').hidden = value.rememberable !== true;
  field('#remember-note').hidden = value.rememberable !== true;
  field('#remember').checked = value.rememberable === true && value.remember === true;
  field('#hint').textContent = `Minimum ${value.minLength} characters. Passwords cannot be recovered if lost.`;
});
field('#password').addEventListener('submit', event => {
  event.preventDefault();
  const password = field('#pw').value, confirm = field('#pw2').value;
  const problem = password.length < request.minLength ? `Password must be at least ${request.minLength} characters.` : bytes(password) > request.maxBytes ? `Password is too long (max ${request.maxBytes} bytes).` : request.purpose === 'create' && password !== confirm ? 'Passwords do not match.' : '';
  field('#error').textContent = problem;
  if (problem) return;
  window.password.submit({password, confirm, remember: request.rememberable === true && field('#remember').checked});
  field('#pw').value = ''; field('#pw2').value = ''; field('#remember').checked = false;
});
field('#cancel').addEventListener('click', () => window.password.cancel());
