const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
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
    const { phoneNumber, captchaCode, sessionCookie } = req.body;
    const config = getSettings();

    // 1. جلب صورة الكابتشا وتمرير الكوكي
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا من لوحة التحكم' });
        }

        try {
            const dynamicUrl = config.captchaImgUrl.includes('?') 
                ? `${config.captchaImgUrl}&_t=${Date.now()}` 
                : `${config.captchaImgUrl}?_t=${Date.now()}`;

            console.log('--- جلب الكابتشا واستخراج كوكي الجلسة ---');
            const imgRes = await axios.get(dynamicUrl, { headers: config.headers || {} });

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
                sessionCookie: originalCookie
            });

        } catch (err) {
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في جلب صورة الكابتشا',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // 2. إرسال الكابتشا + المعرفات المطلوبة (app_key, device_id...)
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';
        const reqHeaders = {
            ...(config.headers || {}),
            ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
        };

        // دمج المعاملات الإضافية (مثل app_key و device_id)
        const baseExtraData = config.extraPayload || {};

        if (config.verifyCaptchaUrl) {
            console.log(`--- 1. إرسال الكابتشا بنفس الجلسة (${captchaCode}) ---`);
            const verifyPayload = { 
                ...baseExtraData,
                [captchaFieldName]: captchaCode 
            };
            const verifyRes = await axios.post(config.verifyCaptchaUrl, verifyPayload, { headers: reqHeaders });
            console.log('استجابة /i:', verifyRes.data);
        }

        console.log('--- 2. إنشاء طلب البحث ---');
        const createPayload = { 
            ...baseExtraData,
            [phoneFieldName]: phoneNumber,
            [captchaFieldName]: captchaCode 
        };
        const createRes = await axios.post(config.createRequestUrl, createPayload, { headers: reqHeaders });

        console.log('--- 3. جلب التقرير والنتائج ---');
        const reportPayload = { 
            ...baseExtraData,
            [phoneFieldName]: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await axios.post(config.getReportUrl, reportPayload, { headers: reqHeaders });

        return res.json({ success: true, data: reportRes.data });

    } catch (err) {
        const status = err.response ? err.response.status : 500;
        const errData = err.response ? err.response.data : err.message;
        console.error(`خطأ أثناء التنفيذ (${status}):`, errData);

        return res.status(status).json({
            success: false,
            message: `فشل التنفيذ (رمز الخطأ: ${status})`,
            errorDetails: errData
        });
    }
});

app.get('/dashboard', (req, res) => {
    const file = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(file)) res.sendFile(file);
    else res.status(404).send('ملف dashboard.html غير موجود');
});

app.get('/', (req, res) => {
    const file = path.join(__dirname, 'index.html');
    if (fs.existsSync(file)) res.sendFile(file);
    else res.status(404).send('ملف index.html غير موجود');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
