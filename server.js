const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const CONFIG_PATH = path.join(__dirname, 'config.json');

// دالة جلب الإعدادات المحفوظة
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
}

// 1. مسارات لوحة التحكم (Settings API)
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'فشل حفظ الإعدادات' });
    }
});

// 2. مسار البحث واستكمال السلسلة الثلاثية
app.post('/api/proxy-search', async (req, res) => {
    const { phoneNumber, captchaCode } = req.body;
    const config = getSettings();

    // إنشاء عميل HTTP يحتفظ بالـ Headers
    const client = axios.create({
        headers: config.headers || {},
        timeout: 15000
    });

    try {
        // -------------------------------------------------------------
        // المرحلة الأولى: جلب صورة الكابتشا استجابةً للـ JSON وحقل imageB64
        // -------------------------------------------------------------
        if (!captchaCode) {
            if (!config.captchaImgUrl) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'يرجى ضبط رابط الكابتشا في لوحة التحكم أولاً' 
                });
            }

            try {
                const imgRes = await client.get(config.captchaImgUrl);
                let base64Image = '';

                // استخراج الصورة من JSON (حقل imageB64) أو النصوص
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

                // إضافة البادئة المخصصة لـ Data URL إذا لم تكن موجودة
                if (base64Image && !base64Image.startsWith('data:image')) {
                    base64Image = `data:image/png;base64,${base64Image}`;
                }

                if (!base64Image) {
                    return res.status(500).json({ 
                        success: false, 
                        message: 'لم يتم العثور على حقل imageB64 في استجابة الكابتشا' 
                    });
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
                    message: 'فشل الاتصال برابط الكابتشا' 
                });
            }
        }

        // -------------------------------------------------------------
        // المرحلة الثانية: تنفيذ الخطوات الثلاث المتتالية بعد إدخال الكابتشا
        // -------------------------------------------------------------

        // الخطوة 1: إرسال الكابتشا للتحقق (POST /i)
        console.log('1. التحقق من الكابتشا عبر /i ...');
        const verifyPayload = { [config.captchaField || 'captcha']: captchaCode };
        const verifyRes = await client.post(config.verifyCaptchaUrl, verifyPayload);

        // التأكد من أن النتيجة Success
        const isSuccess = verifyRes.data && (verifyRes.data.result === 'Success' || verifyRes.data.success === true);
        if (!isSuccess) {
            return res.json({
                success: false,
                message: 'رمز الكابتشا غير صحيح أو انتهت صلاحيته، حاول مرة أخرى.'
            });
        }

        // الخطوة 2: إنشاء طلب البحث (POST /createRequest)
        console.log('2. إنشاء طلب البحث عبر /createRequest ...');
        const createPayload = { [config.phoneField || 'phone']: phoneNumber };
        const createRes = await client.post(config.createRequestUrl, createPayload);

        // الخطوة 3: جلب التقرير والنتائج (POST /getreport)
        console.log('3. جلب التقرير والنتائج عبر /getreport ...');
        const reportPayload = { 
            [config.phoneField || 'phone']: phoneNumber,
            ...(createRes.data && createRes.data.requestId ? { requestId: createRes.data.requestId } : {})
        };
        const reportRes = await client.post(config.getReportUrl, reportPayload);

        // إرجاع النتيجة النهائية
        res.json({
            success: true,
            data: reportRes.data
        });

    } catch (error) {
        console.error('خطأ أثناء المعالجة:', error.message);
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء الاتصال بالموقع الأصلي',
            errorDetails: error.response ? error.response.data : error.message
        });
    }
});

// تقديم الصفحات
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mojz Server running on port ${PORT}`));
