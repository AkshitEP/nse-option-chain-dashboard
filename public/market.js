// Nifty 50 Data (as of 15-May-2026 close)
const NIFTY50 = [
  {n:"Reliance Industries",cmp:1336.40,pe:22.39,mcap:1808487.98,dy:0.41,np:20589,qpv:-12.55,sq:294059,qsv:12.50,roce:10.48},
  {n:"HDFC Bank",cmp:767.50,pe:15.54,mcap:1181607.38,dy:1.69,np:21074.22,qpv:8.05,sq:87182.50,qsv:0.46,roce:7.04},
  {n:"Bharti Airtel",cmp:1905.40,pe:40.43,mcap:1161012.62,dy:0.84,np:9247.40,qpv:-16.49,sq:55383.20,qsv:15.68,roce:18.50},
  {n:"ICICI Bank",cmp:1244.50,pe:16.46,mcap:892242,dy:0.88,np:15680.64,qpv:9.28,sq:49593.75,qsv:2.49,roce:7.20},
  {n:"State Bank of India",cmp:963.20,pe:10.96,mcap:889093.09,dy:1.80,np:20507.98,qpv:0.22,sq:131080.12,qsv:3.34,roce:6.09},
  {n:"TCS",cmp:2264,pe:15.65,mcap:819135.01,dy:2.83,np:13784,qpv:12.22,sq:70698,qsv:9.65,roce:63.03},
  {n:"Bajaj Finance",cmp:910.45,pe:29.51,mcap:566842.01,dy:0.59,np:5553.30,qpv:21.99,sq:21605.79,qsv:18.10,roce:10.82},
  {n:"Larsen & Toubro",cmp:3909,pe:31.33,mcap:537748.69,dy:0.97,np:6133.06,qpv:2.11,sq:82762.16,qsv:11.25,roce:14.96},
  {n:"Hind. Unilever",cmp:2272.20,pe:48.86,mcap:533874.13,dy:1.80,np:2994,qpv:8.62,sq:16351,qsv:7.64,roce:28.42},
  {n:"Infosys",cmp:1119,pe:15.09,mcap:453824.26,dy:4.29,np:8509,qpv:20.87,sq:46402,qsv:13.38,roce:39.95},
  {n:"Sun Pharma",cmp:1878.20,pe:37.13,mcap:450643.09,dy:0.85,np:3381.17,qpv:18.73,sq:15520.54,qsv:13.49,roce:20.21},
  {n:"Maruti Suzuki",cmp:13221,pe:28.32,mcap:415671.64,dy:1.02,np:3659,qpv:-6.45,sq:52462.50,qsv:28.21,roce:19.02},
  {n:"Adani Ports",cmp:1795.10,pe:31.86,mcap:413583.70,dy:0.42,np:3308.30,qpv:11.43,sq:10737.56,qsv:26.50,roce:14.14},
  {n:"M & M",cmp:3123.10,pe:21.96,mcap:388366.49,dy:0.81,np:5259.91,qpv:48.85,sq:54981.91,qsv:29.07,roce:15.45},
  {n:"ITC",cmp:309.45,pe:18.79,mcap:387724.39,dy:4.64,np:5018.45,qpv:9.62,sq:20047.30,qsv:6.69,roce:36.79},
  {n:"Axis Bank",cmp:1244.80,pe:14.67,mcap:387003.91,dy:0.08,np:7642.08,qpv:1.71,sq:34170.99,qsv:5.30,roce:6.24},
  {n:"Kotak Mah. Bank",cmp:387.05,pe:20.24,mcap:384977.93,dy:0.13,np:5423.15,qpv:4.53,sq:17827.36,qsv:6.29,roce:6.93},
  {n:"NTPC",cmp:395.25,pe:15.85,mcap:383260.73,dy:2.11,np:5597.05,qpv:8.42,sq:45845.68,qsv:1.72,roce:10.83},
  {n:"ONGC",cmp:299.35,pe:9.91,mcap:376590.66,dy:4.09,np:11946.42,qpv:16.36,sq:167422.93,qsv:0.13,roce:12.04},
  {n:"Titan Company",cmp:4169.10,pe:71.89,mcap:370126.93,dy:0.26,np:1179,qpv:31.00,sq:26920,qsv:80.48,roce:25.80},
  {n:"Adani Enterprises",cmp:2716,pe:111.31,mcap:353325.60,dy:0.05,np:-166.79,qpv:-121.16,sq:32439.31,qsv:20.30,roce:6.00},
  {n:"UltraTech Cement",cmp:11487,pe:40.93,mcap:338497.96,dy:0.67,np:3000.02,qpv:20.14,sq:25799.47,qsv:11.86,roce:12.78},
  {n:"JSW Steel",cmp:1278.80,pe:34.36,mcap:312724.65,dy:0.22,np:19243,qpv:115.02,sq:51180,qsv:14.19,roce:10.90},
  {n:"Bharat Electronics",cmp:423.65,pe:51.93,mcap:309678.78,dy:0.57,np:1579.70,qpv:20.45,sq:7153.85,qsv:23.97,roce:38.88},
  {n:"HCL Technologies",cmp:1132.60,pe:17.70,mcap:307349.71,dy:4.77,np:4490,qpv:4.20,sq:33981,qsv:12.35,roce:30.60},
  {n:"Bajaj Auto",cmp:10377.50,pe:26.92,mcap:290048.88,dy:1.45,np:3492.21,qpv:101.63,sq:17832.46,qsv:41.01,roce:28.21},
  {n:"Coal India",cmp:462.20,pe:9.16,mcap:284841.30,dy:5.73,np:10907.79,qpv:12.86,sq:46490.03,qsv:22.91,roce:35.34},
  {n:"Power Grid Corp",cmp:305.85,pe:17.86,mcap:284458.97,dy:2.94,np:4546.33,qpv:9.74,sq:11665.61,qsv:-4.97,roce:9.74},
  {n:"Bajaj Finserv",cmp:1728.10,pe:27.84,mcap:276591.04,dy:0.09,np:5226.26,qpv:5.05,sq:38493.79,qsv:5.19,roce:10.52},
  {n:"Nestle India",cmp:1430.50,pe:79.92,mcap:275845.36,dy:0.84,np:1114.11,qpv:28.84,sq:6747.79,qsv:22.60,roce:84.21},
  {n:"Tata Steel",cmp:216.84,pe:23.58,mcap:270692.80,dy:1.66,np:2965,qpv:116.55,sq:63270.13,qsv:12.54,roce:12.64},
  {n:"Asian Paints",cmp:2605.60,pe:61.25,mcap:249928.58,dy:0.95,np:1073.92,qpv:5.54,sq:8867.02,qsv:3.71,roce:25.72},
  {n:"Hindalco Industries",cmp:1067.50,pe:13.85,mcap:239891.43,dy:0.47,np:2049,qpv:-15.80,sq:66521,qsv:13.93,roce:14.80},
  {n:"Eternal",cmp:241.18,pe:635.92,mcap:232747.16,dy:0.00,np:174,qpv:346.15,sq:17292,qsv:196.45,roce:2.97},
  {n:"Shriram Finance",cmp:937.90,pe:22.01,mcap:220671.98,dy:1.15,np:3020.95,qpv:40.94,sq:12513.43,qsv:9.25,roce:11.47},
  {n:"Grasim Industries",cmp:2933.80,pe:43.29,mcap:199651.76,dy:0.34,np:2232.95,qpv:34.68,sq:44311.97,qsv:25.25,roce:7.50},
  {n:"Wipro",cmp:190,pe:15.11,mcap:199443.26,dy:5.79,np:3521.60,qpv:-1.90,sq:24236.30,qsv:7.70,roce:17.88},
  {n:"Eicher Motors",cmp:7014.50,pe:35.62,mcap:192417.70,dy:1.00,np:1420.61,qpv:25.12,sq:6114.04,qsv:22.94,roce:29.81},
  {n:"SBI Life Insurance",cmp:1864.50,pe:75.70,mcap:187012.48,dy:0.14,np:804.64,qpv:-1.09,sq:4071.03,qsv:-82.35,roce:14.95},
  {n:"InterGlobe Aviation",cmp:4314.90,pe:36.81,mcap:166838.20,dy:0.23,np:612.60,qpv:-21.69,sq:23471.90,qsv:6.16,roce:17.34},
  {n:"Jio Financial",cmp:233.06,pe:100.09,mcap:153892.82,dy:0.21,np:272.22,qpv:-13.88,sq:1018.51,qsv:106.49,roce:1.86},
  {n:"Trent",cmp:4101.30,pe:83.84,mcap:145796.07,dy:0.15,np:413.10,qpv:25.83,sq:5027.99,qsv:19.23,roce:27.80},
  {n:"Tech Mahindra",cmp:1370.50,pe:26.86,mcap:134302.72,dy:3.72,np:1356.40,qpv:16.04,sq:15076.10,qsv:12.64,roce:23.14},
  {n:"HDFC Life Insurance",cmp:608.70,pe:68.68,mcap:131346.48,dy:0.34,np:497.49,qpv:4.66,sq:19890.03,qsv:-17.78,roce:10.30},
  {n:"Tata Motors",cmp:356.55,pe:20.62,mcap:131297.24,dy:1.68,np:5878,qpv:-24.63,sq:105447,qsv:7.19,roce:2.73},
  {n:"Tata Consumer",cmp:1234,pe:78.41,mcap:122111.92,dy:0.81,np:424.02,qpv:34.33,sq:5433.62,qsv:17.91,roce:9.36},
  {n:"Apollo Hospitals",cmp:8082.50,pe:63.99,mcap:116213.95,dy:0.24,np:516.30,qpv:38.72,sq:6477.40,qsv:17.20,roce:16.64},
  {n:"Cipla",cmp:1432.10,pe:28.36,mcap:115685.12,dy:0.91,np:542.51,qpv:-54.61,sq:6541.20,qsv:-2.80,roce:16.61},
  {n:"Dr Reddy's Labs",cmp:1336.70,pe:26.59,mcap:111568.60,dy:0.60,np:221.30,qpv:-86.14,sq:7546.40,qsv:-11.51,roce:13.64},
  {n:"Max Healthcare",cmp:1050.10,pe:70.05,mcap:102200.33,dy:0.14,np:300.92,qpv:17.20,sq:2067.52,qsv:10.66,roce:14.88}
];

// Sector definitions
const SECTORS = {
  top10: {id:'top10-table', names: NIFTY50.slice(0,10).map(s=>s.n)},
  it:    {id:'it-table', names:["TCS","Infosys","HCL Technologies","Wipro","Tech Mahindra"]},
  pharma:{id:'pharma-table', names:["Sun Pharma","Cipla","Dr Reddy's Labs","Apollo Hospitals","Max Healthcare"]},
  auto:  {id:'auto-table', names:["Maruti Suzuki","M & M","Bajaj Auto","Tata Motors","Eicher Motors"]},
  metal: {id:'metal-table', names:["JSW Steel","Tata Steel","Hindalco Industries"]},
  adani: {id:'adani-table', names:["Adani Enterprises","Adani Ports"]}
};

function fmt(v){return v>=1000?v.toLocaleString('en-IN',{maximumFractionDigits:2}):v.toFixed(2);}
function clr(v){return v>0?'pos':v<0?'neg':'neu';}

function fillSectorTable(sectorKey){
  const sec = SECTORS[sectorKey];
  const tbody = document.querySelector('#'+sec.id+' tbody');
  const stocks = sec.names.map(name=>NIFTY50.find(s=>s.n===name)).filter(Boolean);
  tbody.innerHTML = stocks.map((s,i)=>`<tr>
    <td>${i+1}</td><td class="name-cell">${s.n}</td>
    <td class="mono">${fmt(s.cmp)}</td><td class="mono">${s.pe.toFixed(2)}</td>
    <td class="mono">${fmt(s.mcap)}</td><td class="mono">${s.dy.toFixed(2)}</td>
    <td class="mono">${s.roce.toFixed(2)}</td>
    <td class="mono ${clr(s.qpv)}">${s.qpv>0?'+':''}${s.qpv.toFixed(2)}%</td>
  </tr>`).join('');
}

function fillFullTable(){
  const tbody = document.querySelector('#nifty50-table tbody');
  tbody.innerHTML = NIFTY50.map((s,i)=>`<tr>
    <td>${i+1}</td><td class="name-cell">${s.n}</td>
    <td class="mono">${fmt(s.cmp)}</td><td class="mono">${s.pe.toFixed(2)}</td>
    <td class="mono">${fmt(s.mcap)}</td><td class="mono">${s.dy.toFixed(2)}</td>
    <td class="mono">${fmt(s.np)}</td>
    <td class="mono ${clr(s.qpv)}">${s.qpv>0?'+':''}${s.qpv.toFixed(2)}%</td>
    <td class="mono">${fmt(s.sq)}</td>
    <td class="mono ${clr(s.qsv)}">${s.qsv>0?'+':''}${s.qsv.toFixed(2)}%</td>
    <td class="mono">${s.roce.toFixed(2)}</td>
  </tr>`).join('');
}

// Init
Object.keys(SECTORS).forEach(fillSectorTable);
fillFullTable();
