package dev.koushik.stash

import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import dev.koushik.stash.data.LinkRecord
import dev.koushik.stash.data.LinkRecord.Status
import dev.koushik.stash.data.RecordStore
import dev.koushik.stash.net.FlushQueueWorker
import dev.koushik.stash.util.toast

/**
 * The home screen: a durable, filterable view of every shared link (Pending /
 * Sent / Failed). Replaces the old pairing screen as MAIN/LAUNCHER — there is
 * nothing to pair, so the first thing you see is what's been delivered and what's
 * still in flight.
 */
class LinksActivity : AppCompatActivity() {

    private lateinit var adapter: LinksAdapter
    private lateinit var tabs: ChipGroup
    private lateinit var emptyView: TextView
    private lateinit var pendingChip: Chip

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_links)

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.action_clear) {
                RecordStore.clearTerminal(this)
                reload()
                true
            } else false
        }

        tabs = findViewById(R.id.tabs)
        emptyView = findViewById(R.id.empty)
        pendingChip = findViewById(R.id.chip_pending)

        adapter = LinksAdapter(onRetry = ::onRetry)
        findViewById<RecyclerView>(R.id.list).apply {
            layoutManager = LinearLayoutManager(this@LinksActivity)
            adapter = this@LinksActivity.adapter
        }

        tabs.setOnCheckedStateChangeListener { _, _ -> reload() }
    }

    override fun onResume() {
        super.onResume()
        // A pending link with the Mac permanently off ages out to EXPIRED here too.
        RecordStore.expireOlderThan(this, FlushQueueWorker.RETENTION_MS)
        reload()
    }

    private fun onRetry(record: LinkRecord) {
        if (record.status != Status.PENDING) RecordStore.requeue(this, record.id)
        FlushQueueWorker.schedule(this)
        toast(getString(R.string.toast_retrying))
        reload()
    }

    private fun reload() {
        val all = RecordStore.all(this)
        val filtered = when (tabs.checkedChipId) {
            R.id.chip_sent -> all.filter { it.status == Status.SENT }
            R.id.chip_failed -> all.filter { it.status == Status.FAILED || it.status == Status.EXPIRED }
            else -> all.filter { it.status == Status.PENDING }
        }
        adapter.submit(filtered)
        emptyView.visibility = if (filtered.isEmpty()) View.VISIBLE else View.GONE

        val pendingCount = all.count { it.status == Status.PENDING }
        pendingChip.text = if (pendingCount > 0) {
            getString(R.string.tab_pending_count, pendingCount)
        } else {
            getString(R.string.tab_pending)
        }
    }
}
