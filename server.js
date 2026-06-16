const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");

const app = express();

//-------------------------------------------------------------------------------------
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

const storage = multer.memoryStorage();
//--------------------------------------------------------------------------------------
const upload = multer({ storage: storage });

app.use(express.static("public"));
app.use(express.json());

const tempStorage = new Map();

// Helper function to convert JSON rows back into a pristine CSV format string
function convertToCSV(records) {
    if (records.length === 0) return "";
    
    // Exact headers mapping back to your original CSV layout
    const headers = [
        "Date", "Manual SI Number", "Cashier", "Barcode", "LOT", 
        "Item Description", "Quantity", "Item Price", "Gross Sales", 
        "Discount Amount", "Net Sales", "Tender_Type", "Type_of_Card", "Approval_Code"
    ];

    const csvRows = [];
    csvRows.push(headers.join(",")); // Add headers row first

    for (const row of records) {
        const values = [
            `"${row.date || ''}"`,
            `"${row.si_no || ''}"`,
            `"${row.cashier || ''}"`,
            `"${row.barcode || ''}"`,
            `"${row.lot_no || ''}"`,
            `"${(row.item_desc || '').replace(/"/g, '""')}"`, // Escape any internal quotes safely
            row.qty,
            row.unit_price,
            row.gross_sales,
            row.discount,
            row.net_sales,
            `"${row.tender_type || ''}"`,
            `"${row.type_of_card || ''}"`,
            `"${row.approval_code || ''}"`
        ];
        csvRows.push(values.join(","));
    }

    return csvRows.join("\n");
}

// STEP 1: Scan the CSV to discover what dates are available inside it
app.post("/scan-dates", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const dates = new Set();

    Readable.from(req.file.buffer)
        .pipe(csv())
        .on("data", (row) => {
            if (row["Date"]) {
                dates.add(row["Date"].trim());
            }
        })
        .on("end", () => {
            const sessionId = crypto.randomUUID();

            tempStorage.set(sessionId, {
                fileBuffer: req.file.buffer,
                originalName: req.file.originalname,
                summary: {},
                records: []
            });

            res.json({ 
                filePath: sessionId, 
                sessionId: sessionId, 
                dates: Array.from(dates).sort() 
            });
        });
});

// STEP 2: Analyze the CSV but filter strictly by the chosen date
app.post("/analyze", (req, res) => {
    const { filePath, selectedDate } = req.body;
    const sessionId = filePath;

    if (!sessionId || !tempStorage.has(sessionId)) {
        return res.status(400).json({ error: "File reference lost. Please scan again." });
    }

    const sessionData = tempStorage.get(sessionId);
    const records = [];
    let netSales = 0;
    let cardPaid = 0;
    let cashPaid = 0;
    const siNumbers = new Set();

    Readable.from(sessionData.fileBuffer)
        .pipe(csv())
        .on("data", (row) => {
            const rowDate = (row["Date"] || "").trim();
            
            // FILTER BY DATE: Skip if it doesn't match selection
            if (rowDate !== selectedDate) return;

            const gross = Number(row["Gross Sales"] || 0);
            const net = Number(row["Net Sales"] || 0);
            const tender = (row["Tender_Type"] || "").toUpperCase();

            netSales += net;

            if (row["Manual SI Number"]) {
                siNumbers.add(row["Manual SI Number"]);
            }

            if (tender === "CREDIT CARD") {
                cardPaid += gross;
            }

            if (tender === "CASH") {
                cashPaid += net;
            }

            records.push({
                date: row["Date"],
                si_no: row["Manual SI Number"],
                cashier: row["Cashier"],
                barcode: row["Barcode"],
                lot_no: row["LOT"],
                item_desc: row["Item Description"],
                qty: Number(row["Quantity"] || 0),
                unit_price: Number(row["Item Price"] || 0),
                gross_sales: gross,
                discount: Number(row["Discount Amount"] || 0),
                net_sales: net,
                tender_type: tender,
                type_of_card: row["Type_of_Card"],
                approval_code: row["Approval_Code"]
            });
        })
        .on("end", () => {
            if (records.length === 0) {
                return res.status(400).json({ error: "No data found for the selected date." });
            }

            const summary = {
                total_si: siNumbers.size,
                net_sales: netSales.toFixed(2),
                card_paid: cardPaid.toFixed(2),
                cash_paid: cashPaid.toFixed(2)
            };

            sessionData.summary = summary;
            sessionData.records = records; // Stores ONLY filtered matching records
            tempStorage.set(sessionId, sessionData);

            res.json({ filePath: sessionId, sessionId, summary, records });
        });
});

// STEP 3: Confirm or Cancel the Upload
app.post("/confirm-upload", (req, res) => {
    const { sessionId, action } = req.body;

    if (!tempStorage.has(sessionId)) {
        return res.status(400).json({ error: "Session expired. Please re-analyze data." });
    }

    if (action === "cancel") {
        tempStorage.delete(sessionId);
        return res.json({ message: "Upload cancelled safely. Staging memory cleared." });
    }

    if (action === "continue") {
        const dataToUpload = tempStorage.get(sessionId);

        // ─── GENERATE TIMESTAMP FILENAME ──────────────────────────────────
        const now = new Date();
        const timestamp = now.getFullYear() + "-" +
            String(now.getMonth() + 1).padStart(2, '0') + "-" +
            String(now.getDate()).padStart(2, '0') + "_" +
            String(now.getHours()).padStart(2, '0') + "-" +
            String(now.getMinutes()).padStart(2, '0') + "-" +
            String(now.getSeconds()).padStart(2, '0');

        const ext = dataToUpload.originalName.split('.').pop();
        const finalFilePath = `${uploadDir}/${timestamp}.${ext}`;

        // ─── CONVERT ONLY THE SELECTED FILTERED RECORDS TO A CSV STRING ───
        const filteredCSVContent = convertToCSV(dataToUpload.records);
        
        // Write the filtered-only string text to disk
        fs.writeFileSync(finalFilePath, filteredCSVContent, "utf-8");
        // ──────────────────────────────────────────────────────────────────

        // ------------------------------------------------------------------
        // POS API UPLOAD LOGIC HERE
        // ------------------------------------------------------------------
        console.log(`Filtered data file successfully saved at: ${finalFilePath}`);
        console.log(`Pushing ${dataToUpload.records.length} records to production API...`);
        console.log(dataToUpload.summary);
        // ------------------------------------------------------------------

        tempStorage.delete(sessionId);
        return res.json({ 
            success: true, 
            message: `Successfully filtered, saved file, and uploaded ${dataToUpload.records.length} records!` 
        });
    }
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));