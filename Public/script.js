let temporaryServerFilePath = null; // Keeps track of where the file sits on the server
let currentSessionId = null;        // Keeps track of the analyzed data package

// Click 1: Scan file to gather available transaction dates
document.getElementById("scanBtn").addEventListener("click", async () => {
    const file = document.getElementById("csvFile").files[0];
    if (!file) return alert("Please select a CSV file first.");

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/scan-dates", {
        method: "POST",
        body: formData
    });

    const data = await response.json();
    temporaryServerFilePath = data.filePath;

    // Populate dropdown with options
    const dropdown = document.getElementById("dateSelect");
    dropdown.innerHTML = ""; // Clear existing options
    
    data.dates.forEach(date => {
        const option = document.createElement("option");
        option.value = date;
        option.textContent = date;
        dropdown.appendChild(option);
    });

    // Make dropdown section visible
    document.getElementById("dateSelectorContainer").style.display = "block";
});

// Click 2: Analyze data for the isolated selected date
document.getElementById("uploadBtn").addEventListener("click", async () => {
    const selectedDate = document.getElementById("dateSelect").value;

    if (!temporaryServerFilePath || !selectedDate) {
        return alert("Please scan file and select a date first.");
    }

    const response = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            filePath: temporaryServerFilePath, 
            selectedDate: selectedDate 
        })
    });

    const data = await response.json();
    if (!response.ok) return alert(data.error);

    currentSessionId = data.sessionId;

    // Render summary UI
    document.getElementById("summary").innerHTML = `
        <div class="card"><h3>Total SI (${selectedDate})</h3><p>${data.summary.total_si}</p></div>
        <div class="card"><h3>Net Sales</h3><p>₱${data.summary.net_sales}</p></div>
        <div class="card"><h3>Card Paid</h3><p>₱${data.summary.card_paid}</p></div>
        <div class="card"><h3>Cash Paid</h3><p>₱${data.summary.cash_paid}</p></div>
    `;

    document.getElementById("jsonOutput").textContent = JSON.stringify(data.records, null, 2);
    document.getElementById("actionPanel").style.display = "block";
});

// Click 3: Confirm final choice
async function handleAction(action) {
    if (!currentSessionId) return;

    if (action === 'cancel' && !confirm("Cancel this upload window?")) return;

    const response = await fetch("/confirm-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, action: action })
    });

    const result = await response.json();
    alert(result.message || result.error);

    if (response.ok) {
        // Reset Everything
        document.getElementById("actionPanel").style.display = "none";
        document.getElementById("dateSelectorContainer").style.display = "none";
        document.getElementById("summary").innerHTML = "";
        document.getElementById("jsonOutput").textContent = "";
        // document.getElementById("csvFile").value = "";
        currentSessionId = null;
        temporaryServerFilePath = null;
    }
}