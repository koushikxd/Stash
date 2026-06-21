package dev.koushik.stash

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import dev.koushik.stash.data.LinkRecord
import dev.koushik.stash.util.asRelativeTime
import dev.koushik.stash.util.hostOrSelf

/**
 * Renders [LinkRecord]s in the Links screen. Each row shows the shared content, a
 * status/time line, an error (for failures), and a Retry action for anything not
 * yet delivered.
 */
class LinksAdapter(
    private val onRetry: (LinkRecord) -> Unit,
) : RecyclerView.Adapter<LinksAdapter.VH>() {

    private val items = mutableListOf<LinkRecord>()

    fun submit(records: List<LinkRecord>) {
        items.clear()
        items.addAll(records)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_link, parent, false)
        return VH(view)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.title)
        private val meta: TextView = view.findViewById(R.id.meta)
        private val error: TextView = view.findViewById(R.id.error)
        private val retry: MaterialButton = view.findViewById(R.id.retry)

        fun bind(record: LinkRecord) {
            val ctx = itemView.context
            title.text = record.text

            val now = System.currentTimeMillis()
            val statusLabel = ctx.getString(
                when (record.status) {
                    LinkRecord.Status.PENDING -> R.string.status_pending
                    LinkRecord.Status.SENT -> R.string.status_sent
                    LinkRecord.Status.FAILED -> R.string.status_failed
                    LinkRecord.Status.EXPIRED -> R.string.status_expired
                }
            )
            val time = (record.sentAt ?: record.updatedAt).asRelativeTime(now)
            meta.text = listOfNotNull(record.url?.hostOrSelf(), statusLabel, time)
                .joinToString(" · ")

            val showError = !record.lastError.isNullOrBlank() &&
                (record.status == LinkRecord.Status.FAILED || record.status == LinkRecord.Status.PENDING)
            error.visibility = if (showError) View.VISIBLE else View.GONE
            if (showError) error.text = record.lastError

            val canRetry = record.status != LinkRecord.Status.SENT
            retry.visibility = if (canRetry) View.VISIBLE else View.GONE
            retry.setOnClickListener { onRetry(record) }
        }
    }
}
