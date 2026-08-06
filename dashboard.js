// dashboard.js

const STORAGE_KEY = 'cad_usage_metrics';
let usageData = [];
let chartInstance = null;

// DOM Elements
const monthInput = document.getElementById('month-input');
const indexInput = document.getElementById('index-input');
const shippingInput = document.getElementById('shipping-input');
const dataForm = document.getElementById('data-form');
const dataTableBody = document.getElementById('data-table-body');
const summaryIndex = document.getElementById('summary-index');
const summaryShipping = document.getElementById('summary-shipping');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    
    // Set default month to current month
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    monthInput.value = `${yyyy}-${mm}`;
    
    initChart();
    updateUI();

    // Event Listeners
    dataForm.addEventListener('submit', handleFormSubmit);
});

// Data Management
function loadData() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        usageData = JSON.parse(stored);
    } else {
        // Seed dummy data if empty
        const currentYear = new Date().getFullYear();
        usageData = [
            { id: `${currentYear}-01`, year: currentYear, month: 1, indexUsage: 120, shippingUsage: 250 },
            { id: `${currentYear}-02`, year: currentYear, month: 2, indexUsage: 135, shippingUsage: 280 },
            { id: `${currentYear}-03`, year: currentYear, month: 3, indexUsage: 150, shippingUsage: 310 },
            { id: `${currentYear}-04`, year: currentYear, month: 4, indexUsage: 180, shippingUsage: 340 },
            { id: `${currentYear}-05`, year: currentYear, month: 5, indexUsage: 210, shippingUsage: 400 },
            { id: `${currentYear}-06`, year: currentYear, month: 6, indexUsage: 240, shippingUsage: 450 }
        ];
        saveData();
    }
    
    // Sort chronologically
    usageData.sort((a, b) => a.id.localeCompare(b.id));
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(usageData));
}

function handleFormSubmit(e) {
    e.preventDefault();
    
    const monthVal = monthInput.value; // Format: YYYY-MM
    const [yearStr, monthStr] = monthVal.split('-');
    
    const newData = {
        id: monthVal,
        year: parseInt(yearStr, 10),
        month: parseInt(monthStr, 10),
        indexUsage: parseInt(indexInput.value, 10) || 0,
        shippingUsage: parseInt(shippingInput.value, 10) || 0,
        updatedAt: new Date().toISOString()
    };

    // Check if exists
    const existingIndex = usageData.findIndex(d => d.id === monthVal);
    if (existingIndex >= 0) {
        if(confirm(`${monthVal} already exists. Do you want to update it?`)) {
            usageData[existingIndex] = newData;
        } else {
            return;
        }
    } else {
        usageData.push(newData);
    }

    // Re-sort
    usageData.sort((a, b) => a.id.localeCompare(b.id));
    saveData();
    
    // Clear form except month
    indexInput.value = '';
    shippingInput.value = '';
    
    updateUI();
}

function deleteRecord(id) {
    if(confirm(`Are you sure you want to delete the record for ${id}?`)) {
        usageData = usageData.filter(d => d.id !== id);
        saveData();
        updateUI();
    }
}

function editRecord(id) {
    const record = usageData.find(d => d.id === id);
    if(record) {
        monthInput.value = record.id;
        indexInput.value = record.indexUsage;
        shippingInput.value = record.shippingUsage;
        // Scroll to form
        document.querySelector('.data-section').scrollIntoView({ behavior: 'smooth' });
    }
}

// UI Updates
function updateUI() {
    renderTable();
    updateSummary();
    updateChart();
}

function updateSummary() {
    if (usageData.length === 0) {
        summaryIndex.textContent = '-';
        summaryShipping.textContent = '-';
        return;
    }
    
    // Get latest month data
    const latest = usageData[usageData.length - 1];
    summaryIndex.textContent = latest.indexUsage.toLocaleString();
    summaryShipping.textContent = latest.shippingUsage.toLocaleString();
}

function renderTable() {
    dataTableBody.innerHTML = '';
    
    // Render reversed (newest first)
    [...usageData].reverse().forEach(row => {
        const tr = document.createElement('tr');
        
        tr.innerHTML = `
            <td><strong>${row.id}</strong></td>
            <td>${row.indexUsage.toLocaleString()}</td>
            <td>${row.shippingUsage.toLocaleString()}</td>
            <td>
                <button class="action-btn edit-btn" onclick="editRecord('${row.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn delete-btn" onclick="deleteRecord('${row.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </td>
        `;
        dataTableBody.appendChild(tr);
    });
}

// Chart Visualization
function initChart() {
    const ctx = document.getElementById('usageChart').getContext('2d');
    
    // Common chart options matching the app's dark theme
    Chart.defaults.color = '#a0aec0';
    Chart.defaults.font.family = "'Outfit', sans-serif";
    
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Index Usage',
                    data: [],
                    borderColor: '#2b74e2', // Accent color
                    backgroundColor: 'rgba(43, 116, 226, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Shipping Usage',
                    data: [],
                    borderColor: '#10b981', // Green
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#e2e8f0',
                    borderColor: '#334155',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

function updateChart() {
    if (!chartInstance) return;
    
    const labels = usageData.map(d => d.id);
    const indexData = usageData.map(d => d.indexUsage);
    const shippingData = usageData.map(d => d.shippingUsage);
    
    chartInstance.data.labels = labels;
    chartInstance.data.datasets[0].data = indexData;
    chartInstance.data.datasets[1].data = shippingData;
    
    chartInstance.update();
}
