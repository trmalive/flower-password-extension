document.addEventListener('DOMContentLoaded', async () => {
    const passwordInput = document.getElementById('password');
    const keyInput = document.getElementById('key');
    const lengthSelect = document.getElementById('length');
    const modeSelect = document.getElementById('mode');
    const rememberCheckbox = document.getElementById('remember');
    const resultContainer = document.getElementById('result-container');
    const fillBtn = document.getElementById('fill-btn');
    const copyBtn = document.getElementById('copy-btn');

    // 1. Load Settings & Password
    chrome.storage.local.get(['memoryPassword', 'remember', 'length', 'mode'], (data) => {
        if (data.remember && data.memoryPassword) {
            passwordInput.value = data.memoryPassword;
            rememberCheckbox.checked = true;
        }
        if (data.length) lengthSelect.value = data.length;
        if (data.mode) modeSelect.value = data.mode;
        
        // Try to generate immediately if we have everything
        tryGenerate();
    });

    // 2. Get Current Tab Domain
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
        try {
            const url = new URL(tab.url);
            const hostname = url.hostname.replace(/^www\./, '');
            const parts = hostname.split('.');
            let domain = parts[0];
            if (parts.length > 2) {
                // e.g. maps.google.com -> google
                domain = parts[parts.length - 2];
            }
            // Flower Password convention: lower case
            keyInput.value = domain;
            tryGenerate();
        } catch (e) {
            console.error("Error parsing URL:", e);
        }
    }

    // 3. Event Listeners
    passwordInput.addEventListener('input', () => {
        saveSettings();
        tryGenerate();
    });
    keyInput.addEventListener('input', tryGenerate);
    lengthSelect.addEventListener('change', () => {
        saveSettings();
        tryGenerate();
    });
    modeSelect.addEventListener('change', () => {
        saveSettings();
        tryGenerate();
    });
    rememberCheckbox.addEventListener('change', saveSettings);

    fillBtn.addEventListener('click', async () => {
        const password = resultContainer.textContent;
        if (!password) return;
        
        // Execute script in the current tab
        chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: fillPassword,
            args: [password]
        });
        
        // Countdown 5s then clear clipboard and close
        let timeLeft = 5;
        if (fillBtn.dataset.interval) clearInterval(parseInt(fillBtn.dataset.interval));
        
        const updateText = () => {
            fillBtn.textContent = `已填充 (${timeLeft}s)`;
        };
        updateText();
        
        const interval = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(interval);
                navigator.clipboard.writeText('');
                window.close();
            } else {
                updateText();
            }
        }, 1000);
        
        fillBtn.dataset.interval = interval;
    });

    copyBtn.addEventListener('click', () => {
        const password = resultContainer.textContent;
        if (!password) return;
        navigator.clipboard.writeText(password).then(() => {
            // Countdown 5s then clear clipboard
            let timeLeft = 5;
            const originalText = "复制 (Copy)";
            
            if (copyBtn.dataset.interval) clearInterval(parseInt(copyBtn.dataset.interval));
            
            const updateText = () => {
                copyBtn.textContent = `已复制! (${timeLeft}s)`;
            };
            updateText();
            
            const interval = setInterval(() => {
                timeLeft--;
                if (timeLeft <= 0) {
                    clearInterval(interval);
                    navigator.clipboard.writeText('');
                    copyBtn.textContent = originalText;
                } else {
                    updateText();
                }
            }, 1000);
            
            copyBtn.dataset.interval = interval;
        });
    });

    function saveSettings() {
        const data = {
            remember: rememberCheckbox.checked,
            length: lengthSelect.value,
            mode: modeSelect.value
        };
        if (rememberCheckbox.checked) {
            data.memoryPassword = passwordInput.value;
        } else {
            chrome.storage.local.remove('memoryPassword');
        }
        chrome.storage.local.set(data);
    }

    function tryGenerate() {
        const password = passwordInput.value;
        const key = keyInput.value;
        const length = parseInt(lengthSelect.value);
        const mode = modeSelect.value;

        if (!password || !key) {
            resultContainer.style.display = 'none';
            resultContainer.textContent = '';
            return;
        }

        try {
            if (typeof hmac_md5 === 'undefined') {
                resultContainer.textContent = "Error: Library not loaded";
                resultContainer.style.display = 'block';
                return;
            }

            // Note: Flower Password uses HMAC-MD5(password, key)
            // But check order: key usually comes first in function signature
            // Our lib: hmac_md5(key, message)
            // Flower Password logic: Key = Memory Password, Message = Site Key
            const hex = hmac_md5(password, key);
            
            let code = '';
            
            if (mode === 'flower') {
                code = hex;
            } else if (mode === 'base64') {
                code = hexToBase64(hex);
            }

            code = code.substring(0, length);
            
            // Flower Password "rule": 
            // If the first char is digit, swap with the first letter? 
            // We implement the simplified version here. 
            // If user wants strict Flower Password compatibility, we can add that logic.
            // (Usually: if first char is number, find first letter and swap. If no letter, keep.)
            
            code = applyFlowerRule(code);

            resultContainer.textContent = code;
            resultContainer.style.display = 'block';
        } catch (e) {
            console.error(e);
        }
    }
    
    function hexToBase64(hex) {
        let str = '';
        for (let i = 0; i < hex.length; i += 2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return btoa(str);
    }

    function applyFlowerRule(code) {
        // Simple implementation of "Flower Password" rule to make it start with a letter if possible
        // This is optional but nice to have
        if (/^\d/.test(code)) {
            // It starts with a digit
            const match = code.match(/[a-zA-Z]/);
            if (match) {
                const firstLetter = match[0];
                const index = match.index;
                // Swap first char with first letter
                const chars = code.split('');
                chars[index] = chars[0];
                chars[0] = firstLetter;
                return chars.join('');
            }
        }
        return code;
    }
});

// Content Script Function (runs in the page)
function fillPassword(password) {
    // Helper to trigger events
    const triggerEvents = (element) => {
        element.focus();
        element.value = password;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    let target = null;
    
    // 0. Priority: Check Active Element
    if (document.activeElement && 
        (document.activeElement.tagName === 'INPUT')) {
        target = document.activeElement;
    }

    // 1. Try to find the visible password input
    if (!target) {
        const inputs = document.querySelectorAll('input[type="password"]');
        for (const input of inputs) {
            if (input.offsetParent !== null && !input.disabled && !input.readOnly) {
                target = input;
                break;
            }
        }
    }

    // 2. Fallback: Search for input with name/id containing "password"
    if (!target) {
        const textInputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (const input of textInputs) {
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            if ((name.includes('pass') || id.includes('pass') || name.includes('pwd') || id.includes('pwd')) && 
                input.offsetParent !== null) {
                target = input;
                break;
            }
        }
    }
    
    // 3. Fallback: Any password input
    if (!target) {
         const inputs = document.querySelectorAll('input[type="password"]');
         if (inputs.length > 0) target = inputs[0];
    }

    if (target) {
        triggerEvents(target);
        console.log("Flower Password: Filled password.");
    } else {
        // Only alert if we are in the top frame to avoid spamming alerts from iframes
        if (window.top === window.self) {
             console.log("Flower Password: No password field found in top frame.");
             // alert("未找到密码输入框 (No password field found)"); // Disabled alert to avoid noise
        }
    }
}