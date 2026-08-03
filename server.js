const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            createRequestUrl: '', 
            getReportUrl: '', 
            phoneField: 'sequenceNumber',
            captchaField: 'jcaptcha',
            extraPayload: {},
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'sequenceNumber', captchaField: 'jcaptcha', extraPayload: {}, headers: {} };
    }
}

function generateDynamicDeviceId() {
    return `g:${crypto.randomUUID()}`;
}

function mergeAndDeduplicateCookies(cookieMap, setCookieHeader) {
    if (!setCookieHeader) return;
    const cookiesArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    
    cookiesArray.forEach(cookieStr => {
        const firstPart = cookieStr.split(';')[0].trim();
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx !== -1) {
            const name = firstPart.substring(0, eqIdx).trim();
            const value = firstPart.substring(eqIdx + 1).trim();
            cookieMap.set(name, value);
        }
    });
}

function buildCookieString(cookieMap) {
    const pairs = [];
    cookieMap.forEach((val, key) => {
        pairs.push(`${key}=${val}`);
    });
    return pairs.join('; ');
}

app.get('/health', (req, res) => res.status(200).send('Server is running healthy!'));
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save settings' });
    }
});

app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionCookie, captchaUuid } = req.body;
    const config = getSettings();
    const dynamicDeviceId = generateDynamicDeviceId();

    if (!config.captchaImgUrl) {
        return res.status(400).json({ success: false, message: 'Please set captchaImgUrl in dashboard first' });
    }

    let targetOrigin = 'https://mojaz.com.sa';
    try {
        const parsedUrl = new URL(config.captchaImgUrl.trim());
        targetOrigin = parsedUrl.origin;
    } catch (e) {
        console.error('Error parsing target origin');
    }

    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ar,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'x-api-version': 'v2',
        'Origin': targetOrigin,
        'Referer': `${targetOrigin}/mojaz/`,
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...(config.headers || {})
    };

    // -------------------------------------------------------------
    // 1. مرحلة جلب الكابتشا (تُنفذ فقط عندما لا يرسل المستخدم رمز الكابتشا)
    // -------------------------------------------------------------
    if (!captchaCode) {
        try {
            const cookieMap = new Map();

            // A. فتح الصفحة الرئيسية لتوليد الجلسة
            try {
                const mainPageRes = await axios.get(`${targetOrigin}/mojaz/`, {
                    headers: baseHeaders,
                    httpsAgent: httpsAgent,
                    timeout: 6000
                });
                mergeAndDeduplicateCookies(cookieMap, mainPageRes.headers['set-cookie']);
            } catch (e) {
                console.log('Main page handshake skipped');
            }

            const initialCookieString = buildCookieString(cookieMap);

            // B. طلب صورة الكابتشا
            const currentTimestamp = Date.now().toString();
            const cleanBaseUrl = config.captchaImgUrl.trim().replace(/\?.*$/, '');
            const fullCaptchaUrl = `${cleanBaseUrl}?${currentTimestamp}`;

            console.log(`--- [1] Fetching New Captcha for Client: ${fullCaptchaUrl} ---`);

            const imgRes = await axios.get(fullCaptchaUrl, { 
                headers: {
                    ...baseHeaders,
                    ...(initialCookieString ? { 'Cookie': initialCookieString } : {})
                },
                httpsAgent: httpsAgent,
                timeout: 10000 
            });

            mergeAndDeduplicateCookies(cookieMap, imgRes.headers['set-cookie']);
            const finalSessionCookie = buildCookieString(cookieMap);

            let extractedUuid = imgRes.headers['captcha-uuid'] || imgRes.headers['captcha_uuid'] || '';
            if (!extractedUuid && typeof imgRes.data === 'object' && imgRes.data !== null) {
                extractedUuid = imgRes.data.captchaUuid || imgRes.data.uuid || '';
            }

            let base64Image = '';
            if (typeof imgRes.data === 'object' && imgRes.data !== null) {
                base64Image = imgRes.data.imageB64 || imgRes.data.captcha || imgRes.data.image || '';
            } else if (typeof imgRes.data === 'string') {
                try {
                    const parsed = JSON.parse(imgRes.data);
                    base64Image = parsed.imageB64 || parsed.captcha || parsed.image || '';
                } catch (e) {
                    base64Image = imgRes.data;
                }
            }

            if (base64Image && !base64Image.startsWith('data:image')) {
                base64Image = `data:image/png;base64,${base64Image}`;
            }

            console.log(`--- Generated Session Cookie: ${finalSessionCookie} ---`);

            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: base64Image,
                sessionCookie: finalSessionCookie,
                captchaUuid: extractedUuid
            });

        } catch (err) {
            const errStatusCode = err.response ? err.response.status : 'NO_RESPONSE';
            const errDetails = err.response ? err.response.data : err.message;
            console.error(`!!! Captcha Fetch Error (${errStatusCode}):`, errDetails);

            return res.status(500).json({ 
                success: false, 
                message: `Failed to fetch captcha (Code: ${errStatusCode})`,
                errorDetails: errDetails
            });
        }
    }

    // -------------------------------------------------------------
    // 2. مرحلة إرسال createRequest (تستخدم الكوكي الأصلية المربوطة بالصورة القادمة من المتصفح)
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'jcaptcha';
        const phoneFieldName = config.phoneField || 'sequenceNumber';

        console.log(`--- [2] Submitting Search using Client Bound Cookie ---`);

        const requestHeaders = {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'Cookie': sessionCookie || '',
            ...(captchaUuid ? { 'captcha-uuid': captchaUuid } : {})
        };

        const mergedPayload = {
            [captchaFieldName]: captchaCode,
            "vehicles": [
                {
                    [phoneFieldName]: phoneNumber
                }
            ],
            ...(config.extraPayload || {})
        };

        console.log(`--- Payload Sent ---`, JSON.stringify(mergedPayload));
        const createRes = await axios.post(
            config.createRequestUrl.trim(), 
            mergedPayload, 
            { headers: requestHeaders, httpsAgent: httpsAgent }
        );

        console.log('createRequest Success:', createRes.data);

        const reportPayload = {
            ...mergedPayload,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };

        console.log('--- [3] Sending getReportPrice ---');
        const reportRes = await axios.post(
            config.getReportUrl.trim(), 
            reportPayload, 
            { headers: requestHeaders, httpsAgent: httpsAgent }
        );

        return res.json({ success: true, data: reportRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        console.error(`--- Request Failed (${status}) ---`, errData);

        return res.status(status).json({
            success: false,
            message: `Execution failed from target server (Code: ${status})`,
            errorDetails: errData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
