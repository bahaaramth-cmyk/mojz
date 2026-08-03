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

    let currentCookies = sessionCookie || '';

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

    if (!captchaCode) {
        try {
            const currentTimestamp = Date.now().toString();
            const cleanBaseUrl = config.captchaImgUrl.trim().replace(/\?.*$/, '');
            const fullCaptchaUrl = `${cleanBaseUrl}?${currentTimestamp}`;

            console.log(`--- [1] Fetching captcha: ${fullCaptchaUrl} ---`);

            const imgRes = await axios.get(fullCaptchaUrl, { 
                headers: baseHeaders,
                httpsAgent: httpsAgent,
                timeout: 10000 
            });

            const setCookieHeader = imgRes.headers['set-cookie'];
            if (setCookieHeader) {
                currentCookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
            }

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

            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: base64Image,
                sessionCookie: currentCookies,
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

    try {
        const captchaFieldName = config.captchaField || 'jcaptcha';
        const phoneFieldName = config.phoneField || 'sequenceNumber';

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
