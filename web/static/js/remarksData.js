// The Remarks page's lists: from "SKIP_Cause_Force Test cases" (New Comments 051826, May 18 2026),
// plus the two "optimization exhausted" skips. Wording is exact - copy it as it is.
export const remarkGroups = [
  {
    key: "skip", title: "Skipped grid", note: "Skip Cause + Driver Text (Description)",
    items: [
      { scenario: "No coverage on the UE. Not able to initiate a call in Stationary or Mobility.", cause: "Test failure", revisit: false,
        texts: ["Test failed even after UE airplane mode ON/OFF. Attempted 3 times"],
        note: "Do not change the wording - this Driver Text is mandatory. Retry the test 3 times with UE airplane mode On/Off, waiting at least 30 sec between retries." },
      { scenario: "Large Rural Cluster: the grid key matches the list, Large_Rural_Classification is 2 or higher, and there's no Alternate Large Rural.", cause: "Other", revisit: false,
        texts: ["No Alternate Large Rural"] },
      { scenario: "Large Rural Cluster: the grid key matches the list, Large_Rural_Classification is 2 or higher, and every Alternate Grid in ranking order has been exhausted.", cause: "Other", revisit: false,
        texts: ["No Alternate Large Rural"] },
      { scenario: "The site has an alarm and the Drive Coordinator told you to skip with revisit.", cause: "Other", revisit: true,
        texts: ["Skipped due to Alarm"] },
      { scenario: "Grid not passed and optimization exhausted: best is 4G only.", cause: "Other", revisit: false,
        texts: ["Throughput not achieved, Best is 4G only coverage even after optimization changes."] },
      { scenario: "Grid not passed and optimization exhausted: low speed, very limited space to test.", cause: "Other", revisit: false,
        texts: ["Throughput not achieved, Low speed even after optimization changes (very limited space to test)."] },
    ],
  },
  {
    key: "force", title: "Force test & proxy grid", note: "Do Force test and test in proxy grids (within 5 miles) - Test Remarks",
    items: [
      { scenario: "Large Rural Cluster: the grid key doesn't match the list, the original grid isn't accessible, and Large_Rural_Classification is 1 or none.",
        action: "Do Force test and perform test in proxy grids (within 5 miles) using items 2 to 7.",
        texts: ["Private road", "Blocked road", "No road", "Private gated community", "Restricted government area"] },
      { scenario: "Blocked Road", action: "Do Force test and perform test in proxy grids.", texts: ["Blocked road"] },
      { scenario: "Private Property", action: "Do Force test and perform test in proxy grids.", texts: ["Private road", "Private gated community"] },
      { scenario: "No Roads", action: "Do Force test and perform test in proxy grids.", texts: ["No road"] },
      { scenario: "Restricted government area, Military", action: "Do Force test and perform test in proxy grids.", texts: ["Restricted government area"] },
      { scenario: "Safety Concerns or No Parking", action: "Do Force test and perform test in proxy grids.", texts: ["Safety concern"] },
    ],
  },
  {
    key: "other", title: "Other scenarios", note: "Test Remarks - add after the Mobility test has run",
    items: [
      { scenario: "Insufficient Movement < 15 sec: can't stay in the grid for 15 sec; the Mobility retry still raises the TEMS alarm.",
        action: "Re-run the Mobility test and stay in the grid for 15 sec. If you can't, continue the test outside the grid and add the proper remark after the MT has run.",
        texts: ["Insufficient road access", "High Speed Road"] },
      { scenario: "Insufficient Movement: not enough road during the Mobility test, can't make U-turns.",
        action: "Perform the Mobility test and add the remark once you can stop at a safe location and the MT has run.",
        texts: ["Traffic Congestion", "Red light"] },
    ],
  },
];
