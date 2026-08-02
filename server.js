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
    const { phoneNumber, captchaCode, sessionCookie } = req.body;
    const config = getSettings();

    // -------------------------------------------------------------
    // المرحلة 1: جلب صورة الكابتشا + استخراج الكوكي وتمريرها للعميل
    // -------------------------------------------------------------
    if (!captchaCode) {
        if (!config.captchaImgUrl) {
            return res.status(400).json({ success: false, message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' });
        }

        try {
            console.log('--- جلب الكابتشا واستخراج كوكي الجلسة ---');
            
            const imgRes = await axios.get(config.captchaImgUrl, {
                headers: config.headers || {}
            });

            // استخراج الكوكيز التي أرجعها الموقع الأصلي مع الصورة
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

            // إرجاع الصورة + الكوكي إلى الواجهة التجريبية الاحتفاظ بها للطلب القادم
            return res.json({
                success: false,
                requireCaptcha: true,
                captchaImage: base64Image,
                sessionCookie: originalCookie
            });

        } catch (err) {
            console.error('خطأ الكابتشا:', err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'فشل جلب صورة الكابتشا من الموقع الأصلي',
                errorDetails: err.response ? err.response.data : err.message
            });
        }
    }

    // -------------------------------------------------------------
    // المرحلة 2: استخدام الكوكي نفسها لاستكمال السلسلة الثلاثية
    // -------------------------------------------------------------
    try {
        const captchaFieldName = config.captchaField || 'captcha';
        const phoneFieldName = config.phoneField || 'phone';

        // دمج الكوكي القادمة من المتصفح التجريبي مع الترويسات الأساسية
        const reqHeaders = {
            ...(config.headers || {}),
            ...(sessionCookie ? { 'Cookie': sessionCookie } : {})
        };

        // 1. التحقق من الكابتشا في مسار /i بنفس الكوكي
        console.log(`--- 1. إرسال الكابتشا بنفس الجلسة (${captchaCode}) ---`);
        const verifyPayload = { [captchaFieldName]: captchaCode };

        const verifyRes = await axios.post(config.verifyCaptchaUrl, verifyPayload, {
            headers: reqHeaders
        });

        console.log('استجابة /i:', verifyRes.data);

        const isSuccess = verifyRes.data && (verifyRes.data.result === 'Success' || verifyRes.data.success === true);
        
        if (!isSuccess) {
            return res.json({
                success: false,
                message: 'رمز الكابتشا غير صحيح أو انتهت صلاحيته.',
                step: 'VERIFY_CAPTCHA_FAILED',
                originalResponse: verifyRes.data
            });
        }

        // 2. إنشاء طلب البحث /createRequest بنفس الكوكي
        console.log('--- 2. إنشاء طلب البحث ---');
        const createPayload = { [phoneFieldName]: phoneNumber };
        const createRes = await axios.post(config.createRequestUrl, createPayload, {
            headers: reqHeaders
        });

        // 3. جلب التقرير /getreport بنفس الكوكي
        console.log('--- 3. جلب التقرير والنتائج ---');
        const reportPayload = { 
            [phoneFieldName]: phoneNumber,
            ...(createRes.data && typeof createRes.data === 'object' ? createRes.data : {})
        };
        const reportRes = await axios.post(config.getReportUrl, reportPayload, {
            headers: reqHeaders
        });

        return res.json({
            success: true,
            data: reportRes.data
        });

    } catch (err) {
        const status = err.response ? err.response.status : 'No Response';
        const responseData = err.response ? err.response.data : err.message;
        
        console.error(`خطأ أثناء التنفيذ (${status}):`, responseData);

        return res.status(status === 'No Response' ? 500 : status).json({
            success: false,
            message: `فشل التنفيذ (رمز الخطأ: ${status})`,
            status: status,
            errorDetails: responseData
        });
    }
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
