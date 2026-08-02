const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

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
            headers: {} 
        };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return { captchaImgUrl: '', verifyCaptchaUrl: '', createRequestUrl: '', getReportUrl: '', phoneField: 'phone', captchaField: 'captcha', headers: {} };
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
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    // جلسة مستقلة لكل طلب
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        headers: config.headers || {},
        timeout: 15000,
        withCredentials: true
    }));

    // -------------------------------------------------------------
    // المرحلة 1: طلب صورة الكابتشا وتوليد الجلسة
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'لم يتم ضبط رابط الكابتشا في لوحة التحكم' });
        }

        try {
            console.log('--- [المرحلة 1] جلب صورة الكابتشا وتوليد جلسة جديدة ---');
            const imgRes = await client.get(config.captchaImgUrl);
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
                captchaImage: base64Image
            });

        } catch (err) {
            console.error('خطأ في جلب الكابتشا:', err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ أثناء جلب صورة الكابتشا من الموقع الأصلي',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // المرحلة 2: التحقق والتنفيذ لجميع الخطوات بعد إدخال الكابتشا
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';

        // 1. إرسال طلب التحقق من الكابتشا إلى /i
        console.log(`--- [المرحلة 2-1] إرسال الرمز (${captchaCode}) إلى ${config.verifyCaptchaUrl} ---`);
        
        const verifyPayload = { [captchaFieldName]: captchaCode };

        let verifyRes;
        try {
            verifyRes = await client.post(config.verifyCaptchaUrl, verifyPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.headers || {})
                }
            });
        } catch (postErr) {
            // إذا فشل كـ JSON، نجرّب الإرسال كـ Form URL Encoded
            console.log('إعادة المحاولة بصيغة URL-Encoded...');
            const params = new URLSearchParams();
            params.append(captchaFieldName, captchaCode);

            verifyRes = await client.post(config.verifyCaptchaUrl, params, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...(config.headers || {})
                }
            });
        }

        console.log('استجابة مسار /i:', verifyRes.data);

        const isSuccess = verifyRes.data && (verifyRes.data.result === 'Success' || verifyRes.data.success === true);
        if (!isSuccess) {
            return res.json({
                success: false,
                message: 'رمز الكابتشا غير صحيح أو انتهت صلاحيته.',
                step: 'VERIFY_CAPTCHA_FAILED',
                originalResponse: verifyRes.data
            });
        }

        // 2. إنشاء طلب البحث /createRequest
        console.log(`--- [المرحلة 2-2] إنشاء طلب البحث للرقم (${phoneNumber}) ---`);
        const createPayload = { [phoneFieldName]: phoneNumber };
        const createRes = await client.post(config.createRequestUrl, createPayload);

        // 3. جلب التقرير والنتائج /getreport
        console.log('--- [المرحلة 2-3] جلب التقرير والنتائج ---');
        const reportPayload = { 
            [phoneFieldName]: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await client.post(config.getReportUrl, reportPayload);

        return res.json({
            success: true,
            data: reportRes.data
        });

    } catch (err) {
        const status = err.response ? err.response.status : 'No Response';
        const responseData = err.response ? err.response.data : err.message;
        
        console.error(`خطأ في تنفيذ السلسلة (رمز ${status}):`, responseData);

        return res.status(status === 'No Response' ? 500 : status).json({
            success: false,
            message: `فشل طلب السلسلة عند الخطوة الحالية (رمز الخطأ: ${status})`,
            status: status,
            errorDetails: responseData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
