try {
    var logtag = '[ Maintenance Script ] ';
    var params = JSON.parse(value);

    var api_url = params.api_url;
    var api_token = params.api_token;
    var periodInput = params.period;
    var hostname = params.hostname;

    if (!api_url) throw 'Missing param api_url';
    if (!api_token) throw 'Missing param api_token';
    if (!hostname) throw 'Missing param hostname';
    if (periodInput === undefined) throw 'Missing param period';

    function convertToSeconds(periodStr) {
        var timeUnits = { y: 31536000, M: 2592000, d: 86400, h: 3600, m: 60, s: 1 };
        var regex = /(\d+)([yMdhms]?)/g;
        var matches;
        var totalSeconds = 0;

        while ((matches = regex.exec(periodStr)) !== null) {
            var val = parseInt(matches[1]);
            var unit = matches[2] || 's';
            if (timeUnits[unit]) {
                totalSeconds += val * timeUnits[unit];
            }
        }
        return totalSeconds;
    }

    // --- EXTENDED LOGIC FOR START TIME WITH DATE ---
    var durationInput = periodInput;
    var time_start = Math.floor(Date.now() / 1000); // Default: Now

    if (periodInput.indexOf(',') > -1) {
        var parts = periodInput.split(',');
        var dateTimeStr = parts[0].trim(); // e.g., "2026-05-27 15:00:00" or "15:00"
        durationInput = parts[1].trim();   // e.g., "3h"

        var dtParts = dateTimeStr.split(' ');
        var dateStr = '';
        var timeStr = '';

        // Check if a date part is present (space separates date and time)
        if (dtParts.length === 2) {
            dateStr = dtParts[0];
            timeStr = dtParts[1];
        } else {
            timeStr = dtParts[0]; // Only time
        }

        var d = new Date();

        // 1. Parse date (if present)
        if (dateStr !== '') {
            var dParts = dateStr.split('-');
            if (dParts.length === 3) {
                // Format: YYYY-MM-DD
                d.setFullYear(parseInt(dParts[0], 10), parseInt(dParts[1], 10) - 1, parseInt(dParts[2], 10));
            } else if (dParts.length === 2) {
                // Format: MM-DD (Current year remains)
                d.setMonth(parseInt(dParts[0], 10) - 1, parseInt(dParts[1], 10));
            }
        }

        // 2. Parse time
        var tParts = timeStr.split(':');
        if (tParts.length >= 2) {
            var hours = parseInt(tParts[0], 10);
            var minutes = parseInt(tParts[1], 10);
            var seconds = tParts.length === 3 ? parseInt(tParts[2], 10) : 0;
            
            d.setHours(hours, minutes, seconds, 0);
            time_start = Math.floor(d.getTime() / 1000);
            
            // 3. Auto-shift: ONLY if NO date was specified and the time is in the past
            var current_time = Math.floor(Date.now() / 1000);
            if (dateStr === '' && time_start < current_time) {
                time_start += 86400; 
                Zabbix.Log(3, logtag + 'Start time is in the past. Moving start to tomorrow.');
            }
        }
    }

    var period = convertToSeconds(durationInput);
    Zabbix.Log(3, logtag + 'Input period: ' + periodInput + ' => duration: ' + durationInput + ' => seconds: ' + period + ' => start_ts: ' + time_start);

    // If period > 0 but < 600, set to 600
    if (period > 0 && period < 600) {
        Zabbix.Log(3, logtag + 'Period is less than 600 seconds, setting period to 600 seconds.');
        period = 600;
    }

    var httpreq = new HttpRequest();
    httpreq.addHeader('Content-Type: application/json');
    httpreq.addHeader('Authorization: Bearer ' + api_token);

    function zbxApiCall(method, paramsObj) {
        var data = {
            jsonrpc: "2.0",
            method: method,
            params: paramsObj,
            id: 1
        };

        var response = httpreq.post(api_url, JSON.stringify(data));
        var responseObj;
        try {
            responseObj = JSON.parse(response);
        } catch (e) {
            throw 'Invalid JSON response from API: ' + response;
        }

        if (responseObj.error) {
            throw 'API error: ' + JSON.stringify(responseObj.error);
        }

        return responseObj.result;
    }

    // Detect Host id
    var hostInfo = zbxApiCall('host.get', {
        filter: { host: [hostname] },
        output: ["hostid", "host"]
    });

    if (!hostInfo || hostInfo.length === 0) {
        throw 'Host "' + hostname + '" not found!';
    }

    var hostid = hostInfo[0].hostid;
    Zabbix.Log(3, logtag + 'Found host: ' + hostname + ' with hostid: ' + hostid);

    // Get existing Script-Maintenances
    var maintenances = zbxApiCall('maintenance.get', {
        hostids: [hostid],
        output: "extend"
    });

    var scriptMaintenanceName = "Script Maintenance Host: " + hostname;
    var existingMaintenance = null;
    if (maintenances && maintenances.length > 0) {
        for (var i = 0; i < maintenances.length; i++) {
            if (maintenances[i].name === scriptMaintenanceName) {
                existingMaintenance = maintenances[i];
                break;
            }
        }
    }

    var MAX_ACTIVE_TILL = 2147468400;
    var time_end = (period > 0) ? (period > (MAX_ACTIVE_TILL - time_start) ? MAX_ACTIVE_TILL : time_start + period) : null;

    if (period === 0) {
        if (existingMaintenance) {
            Zabbix.Log(3, logtag + 'Period=0, deleting existing script maintenance: ' + existingMaintenance.maintenanceid);
            var delResult = zbxApiCall('maintenance.delete', [existingMaintenance.maintenanceid]);
            return "Maintenance deleted.";
        } else {
            return "No script-created maintenance found. Nothing to do.";
        }
    }

    // period > 0 -> create or update maintenance for given host
    var dateStartObj = new Date(time_start * 1000);
    var dateEndObj = new Date(time_end * 1000);
    var description = "Managed by Zabbix Script. From: " + dateStartObj.toLocaleString() + " Until: " + dateEndObj.toLocaleString();

    if (existingMaintenance) {
        // Update existing Maintenance
        var updateParams = {
            maintenanceid: existingMaintenance.maintenanceid,
            active_since: time_start,
            active_till: time_end,
            timeperiods: [{
                "timeperiod_type": 0,
                "period": period,
                "start_date": time_start
            }],
            description: description
        };
        var updateResult = zbxApiCall('maintenance.update', updateParams);
        return "Maintenance updated to run from " + dateStartObj.toLocaleString() + " until " + dateEndObj.toLocaleString();
    } else {
        // Create new maintenance
        var createParams = {
            name: scriptMaintenanceName,
            active_since: time_start,
            active_till: time_end,
            description: description,
            maintenance_type: 0,
            timeperiods: [{
                "timeperiod_type": 0,
                "period": period,
                "start_date": time_start
            }],
            hosts: [{hostid: hostid}]
        };
        var createResult = zbxApiCall('maintenance.create', createParams);
        return "Maintenance created to run from " + dateStartObj.toLocaleString() + " until " + dateEndObj.toLocaleString();
    }

} catch (error) {
    Zabbix.Log(3, '[ Maintenance Script ] Error: ' + error);
    return "Error: " + error;
}
