const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto'); // مكتبة توليد المعرفات العشوائية

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            createRequestUrl: '', 
            getReportUrl: '', 
            phoneField: 'phone',
            captchaField: 'captcha',
            extraPayload: {},
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', extraPayload: {}, headers: {} };
    }
}

// دالة لتوليد device_id عشوائي تماماً لكل زائر محاكي للموقع الأصلي
function generateDynamicDeviceId() {
    const randomUuid = crypto.randomUUID();
    return `g:${randomUuid}`;
}

app.get('/health', (req, res) => res.status(200).send('Server is running healthy!'));
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل حفظ الإعدادات' });
    }
});

app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode, sessionCookie, captchaUuid } = req.body;
    const config = getSettings();

    // توليد device_id فريد ولحظي لهذا الطلب بالتحديد
    const dynamicDeviceId = generateDynamicDeviceId();

    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-api-version': 'v2',
        'Origin': 'https://xxxtestxxx.com',
        'Referer': 'https://xxxtestxxx.com/mojaz/',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...(config.headers || {}),
        ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
    };

    // 1. جلب صورة الكابتشا
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
        }

        try {
            const currentTimestamp = Date.now().toString();
            const baseUrl = config.captchaImgUrl.split('?')[0];
            const fullCaptchaUrl = `${baseUrl}?${currentTimestamp}`;

            console.log(`--- [1] جلب الكابتشا بـ Device ID عشوائي: ${dynamicDeviceId} ---`);
            const imgRes = await axios.get(fullCaptchaUrl, { headers: baseHeaders });

            const setCookieHeader = imgRes.headers['set-cookie'];
            const newCookie = setCookieHeader ? setCookieHeader.join('; ') : sessionCookie || '';

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
                sessionCookie: newCookie,
                captchaUuid: extractedUuid
            });

        } catch (err) {
            return res.status(500).json({ 
                success: false, 
                message: 'فشل جلب صورة الكابتشا من الموقع الأصلي',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // 2. إرسال createRequest و getReportPrice بدمج المعرفات الديناميكية
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';

        const requestHeaders = {
            ...baseHeaders,
            ...(captchaUuid ? { 'captcha-uuid': captchaUuid } : {})
        };

        // دمج الـ device_id المولد ديناميكياً مع باقي البيانات
        const mergedPayload = {
            "device_id": dynamicDeviceId,
            "deviceId": dynamicDeviceId,
            ...(config.extraPayload || {}),
            [phoneFieldName]: phoneNumber,
            [captchaFieldName]: captchaCode
        };

        // الخطوة 1: createRequest
        console.log(`--- [2] إرسال createRequest بالـ Device ID: ${dynamicDeviceId} ---`);
        const createRes = await axios.post(
            config.createRequestUrl, 
            mergedPayload, 
            { headers: requestHeaders }
        );

        // الخطوة 2: getReportPrice
        const reportPayload = {
            ...mergedPayload,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };

        console.log('--- [3] إرسال طلب getReportPrice ---');
        const reportRes = await axios.post(
            config.getReportUrl, 
            reportPayload, 
            { headers: requestHeaders }
        );

        return res.json({ success: true, data: reportRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        console.error(`--- خطأ تنفيذ الطلب (${status}) ---`, errData);

        return res.status(status).json({
            success: false,
            message: `فشل التنفيذ من السيرفر الأصلي (رمز: ${status})`,
            errorDetails: errData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
