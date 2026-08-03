const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// إتاحة المجلد الحالي كملفات استاتيكية
app.use(express.static(__dirname));

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const sessionUuidStore = new Map();

// الإعدادات الثابتة الخاصة بموقع موجز (بدون الحاجة للوحة تحكم)
const CONFIG = {
    captchaImgUrl: 'https://mojaz.com.sa/MojazWeb/captcha-controller/v2/captcha-image?',
    createRequestUrl: 'https://mojaz.com.sa/MojazWeb/api/requests/multiple/createRequest',
    getReportUrl: 'https://mojaz.com.sa/MojazWeb/api/packages/multiple/getReportPrice',
    phoneField: 'sequenceNumber',
    captchaField: 'jcaptcha',
    extraPayload: {},
    headers: {}
};

// ذاكرة تتبع الزوار واللوحة
const activeSockets = new Map();
const visitorLogs = [];
let totalRequestsCount = 0;

io.on('connection', (socket) => {
    socket.on('register_visitor', (userToken) => {
        activeSockets.set(socket.id, { token: userToken, time: new Date().toLocaleTimeString('ar-SA') });
        broadcastStats();
    });

    socket.on('disconnect', () => {
        activeSockets.delete(socket.id);
        broadcastStats();
    });
});

function broadcastStats() {
    const activeTokens = Array.from(new Set(Array.from(activeSockets.values()).map(s => s.token)));
    io.emit('dashboard_update', {
        onlineUsersCount: activeTokens.length,
        totalRequests: totalRequestsCount,
        visitorLogs: visitorLogs.slice(0, 50)
    });
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

// فحص سلامة السيرفر
app.get('/health', (req, res) => res.status(200).send('Server is running healthy!'));

// وكيل جلب الصور لتخطي حظر الشعار من سيرفر موجز
app.get('/api/image-proxy', async (req, res) => {
    try {
        const imageUrl = req.query.url;
        if (!imageUrl) return res.status(400).send('URL required');

        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
                'Referer': 'https://mojaz.com.sa/'
            },
            httpsAgent: httpsAgent
        });

        res.set('Content-Type', response.headers['content-type'] || 'image/png');
        res.send(response.data);
    } catch (e) {
        res.status(404).send('Image not found');
    }
});

// المسار الرئيسي لتلقي طلبات البحث والاستعلام اللحظي
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionCookie, captchaUuid, visitorToken } = req.body;

    let targetOrigin = 'https://mojaz.com.sa';
    try {
        const parsedUrl = new URL(CONFIG.captchaImgUrl.trim());
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
        ...(CONFIG.headers || {})
    };

    // 1. جلب صورة الكابتشا وتنسيق الجلسة
    if (!captchaCode) {
        try {
            const cookieMap = new Map();

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

            const currentTimestamp = Date.now().toString();
            const cleanBaseUrl = CONFIG.captchaImgUrl.trim().replace(/\?.*$/, '');
            const fullCaptchaUrl = `${cleanBaseUrl}?${currentTimestamp}`;

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

            let extractedUuid = imgRes.headers['captcha-uuid'] || 
                                imgRes.headers['captcha_uuid'] || 
                                imgRes.headers['x-captcha-uuid'] || 
                                imgRes.headers['captcha-id'] || '';

            if (!extractedUuid && typeof imgRes.data === 'object' && imgRes.data !== null) {
                extractedUuid = imgRes.data.captchaUuid || imgRes.data.uuid || imgRes.data.captcha_uuid || '';
            }

            if (extractedUuid) {
                sessionUuidStore.set(finalSessionCookie, extractedUuid);
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
                sessionCookie: finalSessionCookie,
                captchaUuid: extractedUuid
            });

        } catch (err) {
            const errStatusCode = err.response ? err.response.status : 'NO_RESPONSE';
            const errDetails = err.response ? err.response.data : err.message;

            return res.status(500).json({ 
                success: false, 
                message: `Failed to fetch captcha (Code: ${errStatusCode})`,
                errorDetails: errDetails
            });
        }
    }

    // 2. إرسال الطلب بعد إدخال الكابتشا (createRequest)
    try {
        const captchaFieldName = CONFIG.captchaField;
        const phoneFieldName = CONFIG.phoneField;
        const activeUuid = captchaUuid || sessionUuidStore.get(sessionCookie || '') || '';

        const requestHeaders = {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'Cookie': sessionCookie || '',
            ...(activeUuid ? { 
                'captcha-uuid': activeUuid, 
                'captcha_uuid': activeUuid,
                'x-captcha-uuid': activeUuid 
            } : {})
        };

        const mergedPayload = {
            [captchaFieldName]: captchaCode,
            "vehicles": [
                {
                    [phoneFieldName]: phoneNumber
                }
            ],
            ...(activeUuid ? { "captchaUuid": activeUuid, "captcha_uuid": activeUuid } : {}),
            ...(CONFIG.extraPayload || {})
        };

        const createRes = await axios.post(
            CONFIG.createRequestUrl.trim(), 
            mergedPayload, 
            { headers: requestHeaders, httpsAgent: httpsAgent }
        );

        sessionUuidStore.delete(sessionCookie || '');

        // تحديث إحصائيات اللوحة
        totalRequestsCount++;
        visitorLogs.unshift({
            id: Date.now(),
            token: visitorToken || 'GUEST-UNKNOWN',
            input: phoneNumber,
            time: new Date().toLocaleTimeString('ar-SA'),
            status: 'نجاح',
            resultData: createRes.data
        });
        broadcastStats();

        return res.json({ success: true, data: createRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;

        // تحديث اللوحة عند حدوث خطأ
        totalRequestsCount++;
        visitorLogs.unshift({
            id: Date.now(),
            token: visitorToken || 'GUEST-UNKNOWN',
            input: phoneNumber,
            time: new Date().toLocaleTimeString('ar-SA'),
            status: `فشل (${status})`,
            resultData: errData
        });
        broadcastStats();

        return res.status(status).json({
            success: false,
            message: `Execution failed from target server (Code: ${status})`,
            errorDetails: errData
        });
    }
});

// توجيه المسارات
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server & Socket running on port ${PORT}`));
