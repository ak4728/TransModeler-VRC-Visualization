# Corridor Travel Time Analyzer

A client-side web application for analyzing transit and vehicle travel times along transportation corridors using VRC sensor data. Compare multiple scenarios with interactive visualizations showing segment-level and corridor-level performance metrics.

![Corridor Travel Time Analyzer](screenshot.png)

## Features

### 📊 Multi-Scenario Comparison
- Upload and compare multiple VRC Sensor Reports simultaneously
- Side-by-side visualization of baseline, build, and alternative scenarios
- Support for CSV and Excel file formats

### 🚌 Flexible Vehicle Filtering
- **Transit Only**: Analyze bus/transit vehicle travel times
- **All Vehicles**: Include all traffic
- **Trucks Only**: Focus on commercial vehicle movements

### 📈 Comprehensive Analysis
- **Segment-Level Analysis**: Travel time by individual corridor segments
- **Corridor-Level Analysis**: End-to-end travel time distributions
- **Time Series**: 15-minute median travel times throughout the peak period
- **Statistical Summaries**: Mean, median, P10, and P90 travel times

### 🎨 Interactive Visualizations
- Bar charts comparing median travel times by segment
- Box plots showing travel time distributions
- Time series plots tracking performance over time
- Summary tables with key statistics

### 🔒 Privacy-Focused
- **100% Client-Side Processing**: All data stays in your browser
- No server uploads or data transmission
- Works completely offline after initial load

## Quick Start

### Live Demo
Open `tt_analyzer.html` in any modern web browser. No installation required!

### Basic Workflow

1. **Load Segment Catalog**
   - Upload your segment catalog Excel file (Direction, Segment Number, Placement, Sensor ID, Location)
   - Defines the corridor structure and sensor order

2. **Add Scenarios**
   - Upload VRC Sensor Report files (one per scenario)
   - Label each scenario (e.g., "NoBuild", "Build", "Alternative")
   - Add or remove scenarios as needed

3. **Configure Analysis**
   - Select vehicle filter (Transit only / All vehicles / Trucks only)
   - Set corridor matching mode (strict or allow missing sensors)
   - Define time window (default: 2-5 PM)

4. **Process & Visualize**
   - Click "Process data" to analyze
   - Switch between visualization tabs
   - Download processed data as CSV

## File Structure

```
corridor-tt-analyzer/
├── tt_analyzer.html       # Main application file
├── styles.css             # Dark theme styling
├── app.js                 # Core analysis logic
└── README.md             # This file
```

## Input File Formats

### Segment Catalog (Excel/CSV)
Defines the corridor structure with columns:

| Direction   | Segment Number | Placement | Sensor ID | Location                    |
|-------------|----------------|-----------|-----------|----------------------------|
| Northbound  | 2              | Start     | 2905      | North of Hampden Ave       |
| Northbound  |                | End       | 2969      | South of Amherst Ave       |
| Northbound  | 3              | Start     | 2969      | South of Amherst Ave       |
| ...         | ...            | ...       | ...       | ...                        |

- **Direction**: Northbound or Southbound
- **Segment Number**: Sequential segment identifiers
- **Placement**: Start or End of segment
- **Sensor ID**: Unique sensor identifier
- **Location**: Human-readable location description

### VRC Sensor Report (CSV/Excel)
Multi-section format with blocks beginning with "Sensor ID XXXX":

```
Sensor ID 2905
Time        Vehicle    Transit    Speed (mph)    Occupants
2:03:45 PM  101        1          35             2
2:05:12 PM  102        1          38             15
...

Sensor ID 2969
Time        Vehicle    Transit    Speed (mph)    Occupants
2:06:30 PM  101        1          33             2
...
```

Required columns:
- **Time**: Timestamp (formats: "h:mm:ss A" or "h:mm A")
- **Vehicle**: Vehicle ID (numeric)
- **Transit**: Binary flag (1 = transit, 0 = other)
- **Truck**: Binary flag (1 = truck, 0 = other) [optional]

## How It Works

### Data Processing Pipeline

1. **Segment Catalog Loading**
   - Parses Excel/CSV with segment definitions
   - Forward-fills blank direction cells
   - Assigns segment numbers to End placements
   - Builds corridor order (NB ascending, SB descending)

2. **VRC Report Parsing**
   - Reads multi-section sensor reports
   - Extracts activations (sensor hits by vehicle)
   - Normalizes timestamps and vehicle IDs
   - Filters by vehicle type and time window

3. **Travel Time Computation**
   - **Link Travel Times**: Time between consecutive sensors
   - **Corridor Travel Times**: End-to-end journey times
   - Deduplicates first hit per vehicle/direction/sensor
   - Uses upstream segment for link labeling

4. **Statistical Analysis**
   - Groups by scenario, direction, and segment
   - Computes median, mean, P10, P90 percentiles
   - Bins data into 15-minute intervals
   - Generates summary statistics

5. **Visualization**
   - Interactive Plotly.js charts
   - Responsive design with tab navigation
   - Real-time updates on direction/segment selection

## Technology Stack

- **Frontend**: Vanilla JavaScript (ES6+)
- **Parsing**: 
  - [PapaParse](https://www.papaparse.com/) for CSV files
  - [SheetJS](https://sheetjs.com/) for Excel files
- **Date/Time**: [Day.js](https://day.js.org/)
- **Visualization**: [Plotly.js](https://plotly.com/javascript/)
- **Styling**: Custom CSS with dark theme

## Browser Compatibility

Tested and working on:
- ✅ Chrome 90+
- ✅ Firefox 88+
- ✅ Edge 90+
- ✅ Safari 14+

## Advanced Features

### Corridor Matching Modes

**Allow missing middle sensors** (default):
- Vehicles must touch first and last sensors
- Can skip intermediate sensors
- More permissive for real-world GPS gaps

**Touch every sensor in order** (strict):
- Vehicles must hit all sensors sequentially
- Ensures complete corridor coverage
- Useful for quality control

### Link Segment Labeling

Travel time for a link between segments N and N+1 is labeled with the **departing segment number** (N), representing the upstream segment in the direction of travel.

### Time Window Filtering

- Default: 2:00 PM - 5:00 PM (afternoon peak)
- Customizable start/end hours
- Filters based on departure times

## Data Export

**Link Data CSV**: Individual segment travel times
- Columns: scenario, direction, segment, bin_15min, depart_ts, arrive_ts, travel_time_s, vehicle_id

**Corridor Data CSV**: End-to-end corridor runs
- Columns: scenario, direction, depart_ts, arrive_ts, corridor_tt_s, visited_count, visited_sensors, bin_15min, corridor_tt_min

## Troubleshooting

### No segments showing in charts
- ✅ Check that segment catalog has both Start and End rows
- ✅ Verify sensor IDs match between catalog and VRC reports
- ✅ Ensure VRC data has vehicles with transit=1 (if using transit filter)

### Missing segment 9 or segment 2
- ✅ Verify End rows have corresponding sensors in the catalog
- ✅ Check that sensors appear in VRC activations data

### Scenario upload disappeared
- ✅ Check browser console for JavaScript errors
- ✅ Verify file format is CSV or Excel (.xlsx, .xls)
- ✅ Ensure VRC report has "Sensor ID XXXX" headers

### Charts not displaying
- ✅ Click "Process data" after uploading files
- ✅ Check that scenarios have uploaded successfully
- ✅ Try refreshing the page and re-uploading

## Development

### Local Setup
```bash
# Clone the repository
git clone https://github.com/yourusername/corridor-tt-analyzer.git
cd corridor-tt-analyzer

# Open in browser
open tt_analyzer.html
# or
python -m http.server 8000
# then navigate to http://localhost:8000
```

### Code Structure

**app.js** main sections:
- State management (lines 1-15)
- Utility functions (lines 17-73)
- File readers (lines 75-101)
- Domain parsers (lines 103-235)
- Travel time computation (lines 237-430)
- Aggregations (lines 432-520)
- Plotting functions (lines 522-700)
- UI event handlers (lines 702-890)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see LICENSE file for details

## Acknowledgments

Built for transportation planners and traffic engineers analyzing corridor performance using VRC sensor data. Inspired by Python-based travel time analysis workflows.

## Contact

Questions? Issues? Open a GitHub issue or reach out to [your-email@example.com]

---

**Note**: This tool processes sensitive transportation data locally in your browser. No data is transmitted to external servers. Always follow your organization's data handling policies.
