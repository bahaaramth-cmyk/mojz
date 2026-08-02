const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

function getSettings() {
    if (!fs.existsSync(CONFIG_PATH)) {
        return { 
            captchaImgUrl: '', 
            verifyCaptchaUrl: '', 
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
        return { captchaImgUrl: '', verifyCaptchaUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', extraPayload: {}, headers: {} };
    }
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
    const { phoneNumber, captchaCode, sessionCookie, requestTimestamp } = req.body;
    const config = getSettings();

    // -------------------------------------------------------------
    // الخطوة 1: توليد الـ Timestamp وجلب صورة الكابتشا
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
        }

        try {
            // توليد Timestamp بالمللي ثانية (مثل: 1785705172106)
            const currentTimestamp = Date.now().toString();

            // تركيبة رابط الكابتشا بالـ Timestamp
            const baseUrl = config.captchaImgUrl.split('?')[0];
            const fullCaptchaUrl = `${baseUrl}?${currentTimestamp}`;

            console.log(`--- توليد Timestamp جديد: ${currentTimestamp} ---`);
            console.log(`--- جلب الكابتشا من: ${fullCaptchaUrl} ---`);

            const imgRes = await axios.get(fullCaptchaUrl, { headers: config.headers || {} });

            const setCookieHeader = imgRes.headers['set-cookie'];
            const originalCookie = setCookieHeader ? setCookieHeader.join('; ') : '';

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
                sessionCookie: originalCookie,
                requestTimestamp: currentTimestamp // إرجاع الـ Timestamp للعميل للالتزام به
            });

        } catch (err) {
            console.error('خطأ في جلب الكابتشا:', err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'فشل جلب صورة الكابتشا من الموقع الأصلي',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // الخطوة 2: تنفيذ السلسلة مع أداء نفس الـ Timestamp للـ Payload
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';
        const reqHeaders = {
            ...(config.headers || {}),
            ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
        };

        // دمج الـ Timestamp ونفس القيم الثابتة المحددة في الإعدادات
        const mergedPayload = {
            ...(config.extraPayload || {}),
            _t: requestTimestamp,
            t: requestTimestamp,
            timestamp: requestTimestamp
        };

        // 1. إرسال الكابتشا لمسار /i
        if (config.verifyCaptchaUrl) {
            const verifyPayload = { 
                ...mergedPayload,
                [captchaFieldName]: captchaCode 
            };
            console.log('--- 1. إرسال الكابتشا بالـ Timestamp المحدد ---', verifyPayload);
            await axios.post(config.verifyCaptchaUrl, verifyPayload, { headers: reqHeaders });
        }

        // 2. إنشاء طلب البحث
        console.log('--- 2. إنشاء طلب البحث ---');
        const createPayload = { 
            ...mergedPayload,
            [phoneFieldName]: phoneNumber,
            [captchaFieldName]: captchaCode 
        };
        const createRes = await axios.post(config.createRequestUrl, createPayload, { headers: reqHeaders });

        // 3. جلب التقرير والنتائج
        console.log('--- 3. جلب التقرير والنتائج ---');
        const reportPayload = { 
            ...mergedPayload,
            [phoneFieldName]: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await axios.post(config.getReportUrl, reportPayload, { headers: reqHeaders });

        return res.json({ success: true, data: reportRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        console.error(`خطأ أثناء تنفيذ السلسلة (رمز ${status}):`, errData);

        return res.status(status).json({
            success: false,
            message: `فشل التنفيذ (رمز الخطأ: ${status})`,
            errorDetails: errData
        });
    }
});

app.get('/dashboard', (req, res) => {
    const filePath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('ملف dashboard.html غير موجود');
});

app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('ملف index.html غير موجود');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
